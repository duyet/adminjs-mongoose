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
      if (property.name().endsWith('_starts_with')) {
        return {
          [property.name().replace('_starts_with', '')]: { $regex: `^${escape(value)}`, $options: 'i' },
          ...memo,
        }
      }
      if (property.name().endsWith('_ends_with')) {
        return {
          [property.name().replace('_ends_with', '')]: { $regex: `${escape(value)}$`, $options: 'i' },
          ...memo,
        }
      }
      if (property.name().endsWith('_equals')) {
        return {
          [property.name().replace('_equals', '')]: escape(value),
          ...memo,
        }
      }
      return {
        [property.name()]: { $regex: escape(value), $options: 'i' },
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
