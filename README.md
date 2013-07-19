# framing-socket

[![Build Status](https://travis-ci.org/matanamir/framing-socket.png)](https://travis-ci.org/matanamir/framing-socket)

FramingSocket adds variable size framing and simple promise-based notifications to normal sockets.

Note that the FramingSocket assumes a request/response protocol of some form where the first frame bytes are the
size of the frame, and each frame response contains an RPC ID to associate it with the sent request.  It uses the
[FramingBuffer][1] internally to handle this framing.

The user can define their own frame_length reader function and rpc_id reader function to find and parse those
values from the frame.

It also includes a simplistic backpressure mechanism based on the number of "falsey" write()s and will emit the
common pause/resume events based on this upstream.

**Note**: *Still experimental. Use with caution*

## Example

```js
var FramingSocket = require('framing-socket');

// there are actually the defaults
var options = {
    timeout_ms: 5000,                               // Client timeout to use in milliseconds
    frame_length_size: 4,                           // frame_length field size in bytes
    frame_length_reader: function(offset_buffer) {  // custom function to read the frame_length
      return offset_buffer.readInt32BE();           // note that it passes in an OffsetBuffer (see 'offset-buffer' repo)
    }
    rpc_id_reader: function(offset_buffer) {        // custom function to read the rpc_id from the buffer
      return offset_buffer.readInt32BE();           // The frame_length field is stripped from this OffsetBuffer already
    }
};

var socket = new FramingSocket(options);
var rpc_id = 123;                                   // Unique RPC ID to identify this request (unique to this connection)

socket.connect('localhost', 8888).then(function on_connect() {
    return socket.write(rpc_id, new Buffer([0x01, 0x02, 0x03]));
}).then(function on_success(frame) {
    // do something with the returned frame (minus the frame_length bytes)
    // ....
    return socket.close();
}).then(function on_closed() {
    // socket closed
});
```

## Usage

### connect(host, port)
Creates a new socket and returns a promise

```js
framing_socket.connect(host, port).then(function on_connect() {
    // socket is now connected successfully...
}).otherwise(function on_error() {
    // failed to connect
});;
```

### close()
Closes an existing socket and returns a promise.

```js
framing_socket.close().always(function on_close() {
    // socket closed!
});
```

### write(rpc_id, data)
Write data to the socket and returns a promise for the response data.
The RPC ID is used to match the request and response together.

```js
var rpc_id = 123;
var data = new Buffer('abcd', 'utf8');
framing_socket.write(rpc_id, data).then(function on_response(frame) {
    // got result frame (Buffer)! do something with it.
});
```

### fail_pending_rpcs()
Fails (rejects) all pending RPCs and calls their errbacks.

```js
var rpc_id = 123;
var data = new Buffer('abcd', 'utf8');
framing_socket.write(rpc_id, data).then(function on_response(frame) {
    // let's assume no response arrives yet...
}).otherwise(function on_error(err) {
    console.log('Oops!');
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
