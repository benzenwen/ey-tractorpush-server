//
// Tractor Push: Node.js, socket.io, Ruby, MongoDB tailed cursor demo
// app.js - main server that delivers index.html and responds to
// socket.io requests.  Uses MongoDB tailed cursor to find data for
// socket.io response. 
//
//
//

//
// ObjectLabs is the maker of MongoLab.com a cloud, hosted MongoDb
// service

// Copyright 2012 ObjectLabs Corp.  

// MIT License, except isCapped() & intervalEach()

// Permission is hereby granted, free of charge, to any person
// obtaining a copy of this software and associated documentation files
// (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge,
// publish, distribute, sublicense, and/or sell copies of the Software,
// and to permit persons to whom the Software is furnished to do so,
// subject to the following conditions:  

// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software. 

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
// BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
// CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE. 

//
// isCapped() & intervalEach() is also Copyright 2009-2010 Christian Amor Kvalheim
// see package.json for attributions.  
//
//
// isCapped() and intervalEach() are
// licensed under the Apache License, Version 2.0 (the "Apache License");
// you may not use this file except in compliance with the Apache License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the Apache License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the Apache License for the specific language governing permissions and
// limitations under the Apache License.
//

//
// NB: I don't provide a durable connection to mongodb that retries on
// failures. Instead I'm relying on a PaaS's durable restarts.
//

var fs = require('fs'), 
url = require('url'),
emitter = require('events').EventEmitter,
assert = require('assert'),

mongo = require('mongodb'),
QueryCommand = mongo.QueryCommand,
Cursor = mongo.Cursor,
Collection = mongo.Collection;

// Heroku-style environment variables
var uristring = process.env.MONGOLAB_URI 
var mongoUrl = url.parse (uristring);

//
// Start http server and bind the socket.io service
//
var app = require('http').createServer(handler), // handler defined below
io = require('socket.io').listen(app);

theport = process.env.PORT || 2000;
app.listen(theport);
console.log ("http server on port: " + theport);

function handler (req, res) {
  fs.readFile(__dirname + '/index.html',
  function (err, data) {
    if (err) {
      res.writeHead(500);
      return res.end('Error loading index.html');
    }
    res.writeHead(200);
    res.end(data);
  });
}

//
// Open mongo database connection
// A capped collection is needed to use tailable cursors
//
mongo.Db.connect (uristring, function (err, db) { 
    console.log ("Attempting connection to " + mongoUrl.protocol + "//" + mongoUrl.hostname + " (complete URL supressed).");
    db.collection ("messages", function (err, collection) {
	collection.isCapped(function (err, capped) { 
	    if (err) {
		console.log ("Error when detecting capped collection.  Aborting.  Capped collections are necessary for tailed cursors.");
		process.exit(1);
	    }
	    if (!capped) {
		console.log (collection + " is not a capped collection. Aborting.  Please use a capped collection for tailable cursors.");
		process.exit(2);
	    }
	    console.log ("Success connecting to " + mongoUrl.protocol + "//" + mongoUrl.hostname + ".");
	    startIOServer (collection);
	});
    });
});

//
// Bind send action to 'connection' event
//
function startIOServer (collection) {
    console.log("Starting ...");

    // Many hosted environments do not support all transport forms currently, (specifically WebSockets).
    // So we force a relatively safe xhr-polling transport.
    // Modify io.configure call to allow other transports.

    io.configure(function () { 
    	io.set("transports", ["xhr-polling"]); 
    	io.set("polling duration", 10); 
	io.set("log level", 2);
    });
    io.sockets.on('connection', function (socket) {
	readAndSend(socket, collection);
    });
};

//
// Read and send data to socket.
// The real work is done here upon receiving a new client connection.
// Queries the database twice and starts sending two types of messages to the client.
// (known bug: if there are no documents in the collection, it doesn't work.)
//
function readAndSend (socket, collection) {
    collection.find({}, {'tailable': 1, 'sort': [['$natural', 1]]}, function(err, cursor) {
	cursor.intervalEach(300, function(err, item) { // intervalEach() is a duck-punched version of each() that waits N milliseconds between each iteration.
	    if(item != null) {
		socket.emit('all', item); // sends to clients subscribed to type 'all'
	    }
	});
    });
    collection.find({'messagetype':'complex'}, {'tailable': 1, 'sort': [['$natural', 1]]}, function(err, cursor) {
	cursor.intervalEach(900, function(err, item) {
	    if(item != null) {
		socket.emit('complex', item); // sends to clients subscribe to type 'complex'
	    }
	});
    });
};
	
//
// Monkey patching mongodb driver 0.9.9-3
//
/**
 * Returns if the collection is a capped collection
 *
 * @param {Function} callback returns if collection is capped.
 * @return {null}
 * @api public
 */
Collection.prototype.isCapped = function isCapped(callback) {
  this.options(function(err, document) {
    if(err != null) {
      callback(err);
    } else if (document == null) { // SEEMS to be a bug?  Just hacke it: by testing document==null and punting back an error.
	callback ("Collection.isCapped options document is null.");
    } else {
      callback(null, document.capped);
    }
  });
};


// Duck-punching mongodb driver Cursor.each.  This now takes an interval that waits 
// 'interval' milliseconds before it makes the next object request... 
Cursor.prototype.intervalEach = function(interval, callback) {
    var self = this;
    if (!callback) {
	throw new Error('callback is mandatory');
    }

    if(this.state != Cursor.CLOSED) {
	//FIX: stack overflow (on deep callback) (cred: https://github.com/limp/node-mongodb-native/commit/27da7e4b2af02035847f262b29837a94bbbf6ce2)
	setTimeout(function(){
	    // Fetch the next object until there is no more objects
	    self.nextObject(function(err, item) {        
		if(err != null) return callback(err, null);

		if(item != null) {
		    callback(null, item);
		    self.intervalEach(interval, callback);
		} else {
		    // Close the cursor if done
		    self.state = Cursor.CLOSED;
		    callback(err, null);
		}

		item = null;
	    });
	}, interval);
    } else {
	callback(new Error("Cursor is closed"), null);
    }
};


