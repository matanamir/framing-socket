var BufferGroup = require('buffer-group'),
    OffsetBuffer = require('offset-buffer'),
    debug = false,
    net = require('net'),
    events = require('events'),
    util = require('util'),
    when = require('when'),
    errors = require('./errors.js')(util);

module.exports = require('./framing-socket.js')(
    OffsetBuffer,
    BufferGroup,
    debug,
    net,
    events,
    util,
    when,
    errors,
    console
);