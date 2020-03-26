/* eslint-disable no-param-reassign */

const {
  BaseResource,
  BaseRecord,
  ValidationError,
} = require('admin-bro')
const _ = require('lodash')
const { unflatten } = require('flat')
const Property = require('./property')
const convertFilter = require('./utils/convert-filter')

// Error thrown by mongoose in case of validation error
const MONGOOSE_VALIDATION_ERROR = 'ValidationError'

// Error thrown by mongoose in case of casting error (writing string to Number field)
const MONGOOSE_CAST_ERROR = 'CastError'

/**
 * Adapter for mongoose resource
 * @private
 */
class Resource extends BaseResource {
  static isAdapterFor(MoongooseModel) {
    return _.get(MoongooseModel, 'base.constructor.name') === 'Mongoose'
  }

  /**
   * @typedef {Object} MongooseModel
   * @private
   * @see https://mongoosejs.com/docs/models.html
  */

  /**
   * Initialize the class with the Resource name
   * @param {MongooseModel} MongooseModel Class which subclass mongoose.Model
   * @memberof Resource
   */
  constructor(MongooseModel) {
    super(MongooseModel)
    this.dbType = 'mongodb'
    this.MongooseModel = MongooseModel
  }

  databaseName() {
    return this.MongooseModel.db.name
  }

  databaseType() {
    return this.dbType
  }

  name() {
    return this.MongooseModel.modelName
  }

  id() {
    return this.MongooseModel.modelName
  }

  properties() {
    return Object.entries(this.MongooseModel.schema.paths).map(([, path], position) => (
      new Property(path, position)
    ))
  }

  property(name) {
    const position = this.properties().findIndex(property => property.path() === name)
    if (position >= 0) {
      return this.properties()[position]
    }
    return null
  }

  async count(filters) {
    return this.MongooseModel.find(convertFilter(filters)).countDocuments()
  }

  async find(filters = {}, { limit = 20, offset = 0, sort = {} }) {
    const { direction, sortBy } = sort
    const sortingParam = { [sortBy]: direction }
    const mongooseObjects = await this.MongooseModel
      .find(convertFilter(filters))
      .skip(offset)
      .limit(limit)
      .sort(sortingParam)
    return mongooseObjects.map(mongooseObject => new BaseRecord(
      Resource.stringifyId(mongooseObject), this,
    ))
  }

  fillPopulatedData(baseRecord, path, recordsHash) {
    const id = baseRecord.param(path)
    if (recordsHash[id]) {
      const referenceRecord = new BaseRecord(
        Resource.stringifyId(recordsHash[id]), this,
      )
      baseRecord.populated[path] = referenceRecord
    }
  }

  async populate(baseRecords, property) {
    const ids = baseRecords.reduce((memo, baseRecord) => {
      if (property.isArray()) {
        const array = baseRecord.param(property.name()) || []
        return [...memo, ...array]
      }
      return [...memo, baseRecord.param(property.name())]
    }, [])
    const records = await this.MongooseModel.find({ _id: ids })
    const recordsHash = records.reduce((memo, record) => {
      memo[record._id] = record
      return memo
    }, {})

    baseRecords.forEach((baseRecord) => {
      if (property.isArray()) {
        const filtered = baseRecord.namespaceParams(property.name()) || {}
        for (const path of Object.keys(filtered)) {
          this.fillPopulatedData(baseRecord, path, recordsHash)
        }
      } else {
        this.fillPopulatedData(baseRecord, property.name(), recordsHash)
      }
    })
  }

  async findOne(id) {
    const mongooseObject = await this.MongooseModel.findById(id)
    return new BaseRecord(Resource.stringifyId(mongooseObject), this)
  }

  async findMany(ids) {
    const mongooseObjects = await this.MongooseModel.find({ _id: ids })
    return mongooseObjects.map(mongooseObject => (
      new BaseRecord(Resource.stringifyId(mongooseObject), this)
    ))
  }

  build(params) {
    return new BaseRecord(Resource.stringifyId(params), this)
  }

  async create(params) {
    const parsedParams = this.parseParams(params)
    let mongooseDocument = new this.MongooseModel(parsedParams)
    try {
      mongooseDocument = await mongooseDocument.save()
    } catch (error) {
      if (error.name === MONGOOSE_VALIDATION_ERROR) {
        throw this.createValidationError(error)
      }
      throw error
    }
    return mongooseDocument.toObject()
  }

  async update(id, params) {
    const parsedParams = this.parseParams(params)
    try {
      const mongooseObject = await this.MongooseModel.findOneAndUpdate({
        _id: id,
      }, {
        $set: unflatten(parsedParams),
      }, {
        runValidators: true,
      })
      return mongooseObject.toObject()
    } catch (error) {
      if (error.name === MONGOOSE_VALIDATION_ERROR) {
        throw this.createValidationError(error)
      }
      // In update cast errors are not wrapped into a validation errors (as it happens in create).
      // that is why we have to have a different way of handling them - check out tests to see
      // example error
      if (error.name === MONGOOSE_CAST_ERROR) {
        throw this.createCastError(error, parsedParams)
      }
      throw error
    }
  }

  async delete(id) {
    return this.MongooseModel.deleteOne({ _id: id })
  }

  createValidationError(originalError) {
    const errors = Object.keys(originalError.errors).reduce((memo, key) => {
      const { message, kind, name } = originalError.errors[key]
      return {
        ...memo,
        [key]: {
          message,
          type: kind || name,
        },
      }
    }, {})
    return new ValidationError(`${this.name()} validation failed`, errors)
  }

  createCastError(originalError, params) {
    // cas error has only the nested path. So when an actual path is 'parents.age'
    // originalError will have just a 'age'. That is why we are finding first param
    // with the same value as the error has and path ending the same like path in
    // originalError or ending with path with array notation: "${path}.0"
    const pathRegex = new RegExp(`${originalError.path}(\\.\\d+)?$`)
    const errorParam = Object.entries(params).find(([key, value]) => (
      value === originalError.value && key.match(pathRegex)
    ))
    const errors = {
      [errorParam[0]]: {
        message: originalError.message,
        type: originalError.kind || originalError.name,
      },
    }
    return new ValidationError(`${this.name()} validation failed`, errors)
  }

  static stringifyId(mongooseObj) {
    // By default Id field is an ObjectID and when we change entire mongoose model to
    // raw object it changes _id field not to a string but to an object.
    // stringify/parse is a path found here: https://github.com/Automattic/mongoose/issues/2790
    // @todo We can somehow speed this up
    const strinigified = JSON.stringify(mongooseObj)
    return JSON.parse(strinigified)
  }

  /**
   * Check all params against values they hold. In case of wrong value it corrects it.
   *
   * What it does esactly:
   * - changes all empty strings to `null`s for the ObjectID properties.
   * - changes all empty strings to [] for array fields
   *
   * @param   {Object}  params  received from AdminBro form
   *
   * @return  {Object}          converted params
   */
  parseParams(params) {
    const parasedParams = { ...params }

    // this function handles ObjectIDs and Arrays recursively
    const handleProperty = (prefix = '') => (property) => {
      const {
        path,
        schema,
        instance,
      } = property
      // mongoose doesn't supply us with the same path as we're using in our data
      // so we need to improvise
      const fullPath = [prefix, path].filter(Boolean).join('.')
      const value = parasedParams[fullPath]

      // this handles missing ObjectIDs
      if (instance === 'ObjectID') {
        if (value === '') {
          parasedParams[fullPath] = null
        }
      }

      // this handles empty Arrays or recurses into all properties of a filled Array
      if (instance === 'Array') {
        if (value === '') {
          parasedParams[fullPath] = []
        } else if (schema && schema.paths) { // we only want arrays of objects (with sub-paths)
          const subProperties = Object.values(schema.paths)
          // eslint-disable-next-line no-plusplus
          for (let i = 0; true; i++) { // loop over every item
            const newPrefix = `${fullPath}.${i}`
            if (parasedParams[newPrefix] === '') {
              // this means we have an empty object here
              parasedParams[newPrefix] = {}
            } else if (!Object.keys(parasedParams).some(key => key.startsWith(newPrefix))) {
              // we're past the last index of this array
              break
            } else {
              // recurse into the object
              subProperties.forEach(handleProperty(newPrefix))
            }
          }
        }
      }

      // this handles all properties of an object
      if (instance === 'Embedded') {
        const subProperties = Object.values(schema.paths)
        subProperties.forEach(handleProperty(fullPath))
      }
    }

    this.properties().forEach(({ mongoosePath }) => handleProperty()(mongoosePath))

    return parasedParams
  }
}

module.exports = Resource
