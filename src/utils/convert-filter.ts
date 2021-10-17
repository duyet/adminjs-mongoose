import escape from 'escape-regexp'
import mongoose from 'mongoose'
import { flat } from 'adminjs'

/**
 * Changes AdminJS's {@link Filter} to an object acceptible by a mongoose query.
 *
 * @param {Filter} filter
 * @private
 */
export const convertFilter = (filter) => {
  if (!filter) {
    return {}
  }

  const filterValue = (value: any) => {
    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      if ('starts_with' in value) {
        return ({ $regex: `^${escape(value.starts_with)}`, $options: 'i' })
      }
      if ('ends_with' in value) {
        return ({ $regex: `${escape(value.ends_with)}$`, $options: 'i' })
      }
      if ('contains' in value) {
        return ({ $regex: `${escape(value.contains)}`, $options: 'i' })
      }
    }

    return ({ $regex: `${escape(value)}`, $options: 'i' })
  }

  return filter.reduce((memo, filterProperty) => {
    const { path, property, value } = filterProperty

    // Nested filter, e.g. 'a.b': { path: 'a.b', property: null, value: 'abc' }
    if (!property && path) {
      const nestedFilter = { [path]: escape(value) }

      return {
        ...flat.unflatten(nestedFilter),
        ...memo,
      }
    }

    switch (property.type()) {
    case 'string':
      return {
        [property.name()]: filterValue(value),
        ...memo,
      }
    case 'date':
    case 'datetime':
      if (value.from || value.to) {
        return {
          [property.name()]: {
            ...value.from && { $gte: value.from },
            ...value.to && { $lte: value.to },
          },
          ...memo,
        }
      }
      break
    case 'id':
      if (mongoose.Types.ObjectId.isValid(value)) {
        return {
          [property.name()]: value,
          ...memo,
        }
      }
      return {}
    default:
      break
    }
    return {
      [property.name()]: value,
      ...memo,
    }
  }, {})
}
