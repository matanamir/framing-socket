# framing-socket

[![Build Status](https://travis-ci.org/matanamir/framing-socket.png)](https://travis-ci.org/matanamir/framing-socket)

FramingSocket adds variable size framing to normal sockets.

Note that the FramingSocket assumes a request/response protocol of some form where the first frame bytes are the
size of the frame, and each frame response contains an RPC ID to associate it with the sent request.  It uses the
[FramingBuffer][1] internally to handle this framing.

The user can define their own frame_length reader function and rpc_id reader function to find and parse those
values from the frame.

It also includes a simplistic back pressure mechanism based on the socket.bufferSize in two stages.  warn_buffer_bytes
  is the first watermark to start telling a user to back off via 'pause' and 'resume' events.  max_buffer_bytes is
  the second watermark where writes will be rejected completely.

**Note**: *Still experimental.*

## Example

```js
var FramingSocket = require('framing-socket');
var socket = new FramingSocket();
var rpc_id = 123;                                   // Unique RPC ID to identify this request (unique to this connection)

function on_frame(err, data) {
    // do something with the returned frame (minus the frame_length bytes)
    // ....
    // got what we wanted so let's close the connection
    socket.close();
}

function on_connect(err) {
    if (err) {
        // oops - failed to connect...
        return;
    }
    socket.write(rpc_id, new Buffer([0x01, 0x02, 0x03]), on_frame);
}

socket.connect('localhost', 8888, on_connect);
```

If you want control of how the fields are read and written:

```js
var FramingSocket = require('framing-socket');

// these are actually the defaults
var options = {
    // Client timeout to use in milliseconds
    timeout_ms: 5000,
    // memory watermark before emitting 'pause' and 'resume'
    // events to throttle writes (hopefully)
    warn_buffer_bytes: 524288,
    // Maximum memory to buffer for a socket before
    // rejecting writes
    max_buffer_bytes: 1048576,
    // frame_length field size in bytes
    frame_length_size: 4,
    // custom writer function for the frame_length field
    frame_length_writer: function(offset_buffer, frame_length) {
        offset_buffer.writeInt32BE(frame_length);
    },
    // custom function to read the frame_length
    // note that it passes in an OffsetBuffer (see 'offset-buffer' repo)
    frame_length_reader: function(offset_buffer) {
        return offset_buffer.readInt32BE();
    },
    // rpc_id size in bytes
    rpc_id_size: 4,
    // custom writer function for the rpc_id
    rpc_id_writer: function(offset_buffer, rpc_id) {
        offset_buffer.writeInt32BE(rpc_id);
    },
    // custom reader function for the rpc_id
    rpc_id_reader: function(offset_buffer) {
        // The frame_length field is stripped from this OffsetBuffer already
        return offset_buffer.readInt32BE();
    }
};

var socket = new FramingSocket(options);

//...
```

## Usage

### connect(host, port, callback)
Creates a new socket calls the callback when the connection is complete.

```js
framing_socket.connect(host, port, function on_connect(err) {
    if (!err) {
        // socket is now connected successfully...
    }
});
```

### close()
Closes an existing socket.  This is a synchronous operation.

```js
framing_socket.close();
```

### write(rpc_id, data, callback)
Write data to the socket and calls the callback for the response frame.
The RPC ID is used to match the request and response together.

```js
var rpc_id = 123;
var data = new Buffer('abcd', 'utf8');
framing_socket.write(rpc_id, data, function on_frame(err, frame) {
    if (!err) {
        // got result frame (OffsetBuffer)! do something with it.
    }
});
```

### fail_pending_rpcs()
Fails (rejects) all pending RPCs and calls their callbacks with an err.

```js
var rpc_id = 123;
var data = new Buffer('abcd', 'utf8');
framing_socket.write(rpc_id, data, function on_frame(err, frame) {
    if (err) {
        console.log('Oops!');
    } else {
        // shouldn't get here
    }
});

framing_socket.fail_pending_rpcs();
// Outputs 'Oops!'
```

### event: disconnected(host, port, last_err)
When the connection has an unplanned disconnection. It includes the last detected error object.
It is not emitted when close() is called.

```js
framing_socket.on('disconnected', function on_disconnected(host, port, last_err) {
    // This was unplanned.  Try to reconnect?
});
```

### event: timeout(host, port)
When the socket times out.  The user can decide to what to do after this.

```js
framing_socket.on('timeout', function on_timeout(host, port) {
    // Socket timed out.  Try to reconnect or fail everything?
});
```

### event: pause(host, port)
Sent when it wants the user to pause upstream events including the server's host/port.

```js
framing_socket.on('pause', function on_pause(host, port) {
    // Please slow down!
});
```

### event: resume(host, port)
Sent when the user can continue - including the server's host/port for reference.

```js
framing_socket.on('resume', function on_resume(host, port) {
    // Ok, go nuts.
});
```

## Install

```
npm install framing-socket
```

## Tests

```
npm test
```

## License

MIT License

[1]: https://github.com/matanamir/framing-buffer
