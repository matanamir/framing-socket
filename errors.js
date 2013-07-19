/*
 * Errors thrown by the FramingSocket
 * This is in addition to the standard JS Errors (some more useful than others):
 *
 * EvalError
 * RangeError
 * ReferenceError
 * SyntaxError
 * TypeError
 * URIError
 */

module.exports = function (util) {
    var errors = {};

    errors.RecoverableError = function(message) {
        Error.call(this);
        this.name = 'RecoverableError';
        this.message = message;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, errors.RecoverableError);
        }
    };
    util.inherits(errors.RecoverableError, Error);

    errors.NonRecoverableError = function(message) {
        Error.call(this);
        this.name = 'NonRecoverableError';
        this.message = message;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, errors.NonRecoverableError);
        }
    };
    util.inherits(errors.NonRecoverableError, Error);

    /*
     * ---------------------------------------------------------------------
     * The errors below must either extend Recoverable or Nonrecoverable
     * ---------------------------------------------------------------------
     */

    errors.HostUnavailableError = function(message) {
        Error.call(this);
        this.name = 'HostUnavailableError';
        this.message = message;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, errors.HostUnavailableError);
        }
    };
    util.inherits(errors.HostUnavailableError, errors.RecoverableError);

    errors.AlreadyConnectedError = function(message) {
        Error.call(this);
        this.name = 'AlreadyConnectedError';
        this.message = message;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, errors.AlreadyConnectedError);
        }
    };
    util.inherits(errors.AlreadyConnectedError, errors.RecoverableError);

    errors.NotConnectedError = function(message) {
        Error.call(this);
        this.name = 'NotConnectedError';
        this.message = message;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, errors.NotConnectedError);
        }
    };
    util.inherits(errors.NotConnectedError, errors.RecoverableError);

    errors.DuplicateDataError = function(message) {
        Error.call(this);
        this.name = 'DuplicateDataError';
        this.message = message;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, errors.DuplicateDataError);
        }
    };
    util.inherits(errors.DuplicateDataError, errors.RecoverableError);

    return errors;
};

