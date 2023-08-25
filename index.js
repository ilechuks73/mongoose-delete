var mongoose = require('mongoose'),
    Schema = mongoose.Schema,
    Model = mongoose.Model,
    util = require('util');

/**
 * This code is taken from official mongoose repository
 * https://github.com/Automattic/mongoose/blob/master/lib/query.js#L3847-L3873
 */
function parseUpdateArguments(conditions, doc, options, callback) {
    if ('function' === typeof options) {
        // .update(conditions, doc, callback)
        callback = options;
        options = null;
    } else if ('function' === typeof doc) {
        // .update(doc, callback);
        callback = doc;
        doc = conditions;
        conditions = {};
        options = null;
    } else if ('function' === typeof conditions) {
        // .update(callback)
        callback = conditions;
        conditions = undefined;
        doc = undefined;
        options = undefined;
    } else if (typeof conditions === 'object' && !doc && !options && !callback) {
        // .update(doc)
        doc = conditions;
        conditions = undefined;
        options = undefined;
        callback = undefined;
    }

    var args = [];

    if (conditions) args.push(conditions);
    if (doc) args.push(doc);
    if (options) args.push(options);
    if (callback) args.push(callback);

    return args;
}

function parseIndexFields(options) {
    var indexFields = {
        deleted: false,
        deletedAt: false,
        deletedBy: false
    };

    if (!options.indexFields) {
        return indexFields;
    }

    if ((typeof options.indexFields === 'string' || options.indexFields instanceof String) && options.indexFields === 'all') {
        indexFields.deleted = indexFields.deletedAt = indexFields.deletedBy = true;
    }

    if (typeof (options.indexFields) === "boolean" && options.indexFields === true) {
        indexFields.deleted = indexFields.deletedAt = indexFields.deletedBy = true;
    }

    if (Array.isArray(options.indexFields)) {
        indexFields.deleted = options.indexFields.indexOf('deleted') > -1;
        indexFields.deletedAt = options.indexFields.indexOf('deletedAt') > -1;
        indexFields.deletedBy = options.indexFields.indexOf('deletedBy') > -1;
    }

    return indexFields;
}

function createSchemaObject(typeKey, typeValue, options) {
    options[typeKey] = typeValue;
    return options;
}

module.exports = function (schema, options) {
    options = { indexFieldMapping: { deleted: "deleted", deletedAt: "deletedAt", deletedBy: "deletedBy" }, ...options } || { indexFieldMapping: { deleted: "deleted", deletedAt: "deletedAt", deletedBy: "deletedBy" } };
    var indexFields = parseIndexFields(options);

    var typeKey = schema.options.typeKey;
    var mongooseMajorVersion = +mongoose.version[0]; // 4, 5...
    var mainUpdateMethod = mongooseMajorVersion < 5 ? 'update' : 'updateMany';
    var mainUpdateWithDeletedMethod = mainUpdateMethod + 'WithDeleted';

    function updateDocumentsByQuery(schema, conditions, updateQuery, callback) {
        if (schema[mainUpdateWithDeletedMethod]) {
            return schema[mainUpdateWithDeletedMethod](conditions, updateQuery, { multi: true }, callback);
        } else {
            return schema[mainUpdateMethod](conditions, updateQuery, { multi: true }, callback);
        }
    }

    schema.add({ [options.indexFieldMapping.deleted]: createSchemaObject(typeKey, Boolean, { default: false, index: indexFields.deleted }) });

    if (options.deletedAt === true) {
        schema.add({ [options.indexFieldMapping.deletedAt]: createSchemaObject(typeKey, Date, { index: indexFields.deletedAt }) });
    }

    if (options.deletedBy === true) {
        schema.add({ [options.indexFieldMapping.deletedBy]: createSchemaObject(typeKey, options.deletedByType || Schema.Types.ObjectId, { index: indexFields.deletedBy }) });
    }

    var use$neOperator = true;
    if (options.use$neOperator !== undefined && typeof options.use$neOperator === "boolean") {
        use$neOperator = options.use$neOperator;
    }

    schema.pre('save', function (next) {
        if (!this[options.indexFieldMapping.deleted]) {
            this[options.indexFieldMapping.deleted] = false;
        }
        next();
    });

    if (options.overrideMethods) {
        var overrideItems = options.overrideMethods;
        var overridableMethods = ['count', 'countDocuments', 'find', 'findOne', 'findOneAndUpdate', 'update', 'updateOne', 'updateMany', 'aggregate'];
        var finalList = [];

        if ((typeof overrideItems === 'string' || overrideItems instanceof String) && overrideItems === 'all') {
            finalList = overridableMethods;
        }

        if (typeof (overrideItems) === "boolean" && overrideItems === true) {
            finalList = overridableMethods;
        }

        if (Array.isArray(overrideItems)) {
            overrideItems.forEach(function (method) {
                if (overridableMethods.indexOf(method) > -1) {
                    finalList.push(method);
                }
            });
        }

        if (finalList.indexOf('aggregate') > -1) {
            schema.pre('aggregate', function () {
                var firstMatch = this.pipeline()[0];

                if (
                    firstMatch.$match?.[options.indexFieldMapping.deleted]?.$ne !== false
                ) {
                    if (firstMatch.$match?.showAllDocuments === 'true') {
                        var { showAllDocuments, ...replacement } = firstMatch.$match;
                        this.pipeline().shift();
                        if (Object.keys(replacement).length > 0) {
                            this.pipeline().unshift({ $match: replacement });
                        }
                    } else {
                        this.pipeline().unshift({ $match: { [options.indexFieldMapping.deleted]: { '$ne': true } } });
                    }
                }
            });
        }

        finalList.forEach(function (method) {
            if (['count', 'countDocuments', 'find', 'findOne'].indexOf(method) > -1) {
                var modelMethodName = method;

                schema.statics[method] = function () {
                    var query = Model[modelMethodName].apply(this, arguments);
                    if (!arguments[2] || arguments[2].withDeleted !== true) {
                        if (use$neOperator) {
                            query.where(options.indexFieldMapping.deleted).ne(true);
                        } else {
                            query.where({ [options.indexFieldMapping.deleted]: false });
                        }
                    }
                    return query;
                };
                schema.statics[method + 'Deleted'] = function () {
                    if (use$neOperator) {
                        return Model[modelMethodName].apply(this, arguments).where(options.indexFieldMapping.deleted).ne(false);
                    } else {
                        return Model[modelMethodName].apply(this, arguments).where({ [options.indexFieldMapping.deleted]: true });
                    }
                };
                schema.statics[method + 'WithDeleted'] = function () {
                    return Model[modelMethodName].apply(this, arguments);
                };
            } else {
                if (method === 'aggregate') {
                    schema.statics[method + 'Deleted'] = function () {
                        var args = [];
                        Array.prototype.push.apply(args, arguments);
                        var match = { $match: { [options.indexFieldMapping.deleted]: { '$ne': false } } };
                        arguments.length ? args[0].unshift(match) : args.push([match]);
                        return Model[method].apply(this, args);
                    };

                    schema.statics[method + 'WithDeleted'] = function () {
                        var args = [];
                        Array.prototype.push.apply(args, arguments);
                        var match = { $match: { showAllDocuments: 'true' } };
                        arguments.length ? args[0].unshift(match) : args.push([match]);
                        return Model[method].apply(this, args);
                    };
                } else {
                    schema.statics[method] = function () {
                        var args = parseUpdateArguments.apply(undefined, arguments);

                        if (use$neOperator) {

                            args[0][options.indexFieldMapping.deleted] = { '$ne': true };
                        } else {

                            args[0][options.indexFieldMapping.deleted] = false;
                        }

                        return Model[method].apply(this, args);
                    };

                    schema.statics[method + 'Deleted'] = function () {
                        var args = parseUpdateArguments.apply(undefined, arguments);

                        if (use$neOperator) {
                            args[0][options.indexFieldMapping.deleted] = { '$ne': false };
                        } else {
                            args[0][options.indexFieldMapping.deleted] = true;
                        }

                        return Model[method].apply(this, args);
                    };

                    schema.statics[method + 'WithDeleted'] = function () {
                        return Model[method].apply(this, arguments);
                    };
                }
            }
        });
    }

    schema.methods.delete = function (deletedBy, cb) {
        if (typeof deletedBy === 'function') {
            cb = deletedBy;
            deletedBy = null;
        }

        this[options.indexFieldMapping.deleted] = true;

        if (schema.path(options.indexFieldMapping.deletedAt)) {
            this[options.indexFieldMapping.deletedAt] = new Date();
        }

        if (schema.path(options.indexFieldMapping.deletedBy)) {
            this[options.indexFieldMapping.deletedBy] = deletedBy;
        }

        if (options.validateBeforeDelete === false) {
            return this.save({ validateBeforeSave: false }, cb);
        }

        return this.save(cb);
    };

    schema.statics.delete = function (conditions, deletedBy, callback) {
        if (typeof deletedBy === 'function') {
            callback = deletedBy;
            conditions = conditions;
            deletedBy = null;
        } else if (typeof conditions === 'function') {
            callback = conditions;
            conditions = {};
            deletedBy = null;
        }

        var doc = {
            [options.indexFieldMapping.deleted]: true
        };

        if (schema.path(options.indexFieldMapping.deletedAt)) {
            doc[options.indexFieldMapping.deletedAt] = new Date();
        }

        if (schema.path(options.indexFieldMapping.deletedBy)) {
            doc[options.indexFieldMapping.deletedBy] = deletedBy;
        }

        return updateDocumentsByQuery(this, conditions, doc, callback);
    };

    schema.statics.deleteById = function (id, deletedBy, callback) {
        if (arguments.length === 0 || typeof id === 'function') {
            var msg = 'First argument is mandatory and must not be a function.';
            throw new TypeError(msg);
        }

        var conditions = {
            _id: id
        };

        return this.delete(conditions, deletedBy, callback);
    };

    schema.methods.restore = function (callback) {
        this[options.indexFieldMapping.deleted] = false;
        this.deletedAt = undefined;
        this.deletedBy = undefined;

        if (options.validateBeforeRestore === false) {
            return this.save({ validateBeforeSave: false }, callback);
        }

        return this.save(callback);
    };

    schema.statics.restore = function (conditions, callback) {
        if (typeof conditions === 'function') {
            callback = conditions;
            conditions = {};
        }

        var doc = {
            $unset: {
                [options.indexFieldMapping.deleted]: true,
                [options.indexFieldMapping.deletedAt]: true,
                [options.indexFieldMapping.deletedBy]: true
            }
        };

        return updateDocumentsByQuery(this, conditions, doc, callback);
    };
};
