var mongodb = process.env['TEST_NATIVE'] != null ? require('../../lib/mongodb').native() : require('../../lib/mongodb').pure();
var noReplicasetStart = process.env['NO_REPLICASET_START'] != null ? true : false;

var testCase = require('nodeunit').testCase,
  debug = require('util').debug,
  inspect = require('util').inspect,
  gleak = require('../../dev/tools/gleak'),
  ReplicaSetManager = require('../tools/replica_set_manager').ReplicaSetManager,
  Db = mongodb.Db,
  ReplSetServers = mongodb.ReplSetServers,
  Server = mongodb.Server,
  Step = require("step");  

// Keep instance of ReplicaSetManager
var serversUp = false;
var retries = 120;
var RS = RS == null ? null : RS;

var ensureConnection = function(test, numberOfTries, callback) {
  // Replica configuration
  var replSet = new ReplSetServers( [ 
      new Server( RS.host, RS.ports[1], { auto_reconnect: true } ),
      new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
      new Server( RS.host, RS.ports[2], { auto_reconnect: true } )
    ], 
    {rs_name:RS.name}
  );
  
  if(numberOfTries <= 0) return callback(new Error("could not connect correctly"), null);

  var db = new Db('integration_test_', replSet, {w:0});
  // Print any errors
  db.on("error", function(err) {
    console.log("============================= ensureConnection caught error")
    console.dir(err)
    if(err != null && err.stack != null) console.log(err.stack)
    db.close();
  })

  // Open the db
  db.open(function(err, p_db) {
    db.close();
    if(err != null) {
      // Wait for a sec and retry
      setTimeout(function() {
        numberOfTries = numberOfTries - 1;
        ensureConnection(test, numberOfTries, callback);
      }, 1000);
    } else {
      return callback(null, p_db);
    }    
  })            
}

/**
 * Retrieve the server information for the current
 * instance of the db client
 * 
 * @ignore
 */
exports.setUp = function(callback) {
  // Create instance of replicaset manager but only for the first call
  if(!serversUp && !noReplicasetStart) {
    serversUp = true;
    RS = new ReplicaSetManager({retries:120, secondary_count:2, passive_count:1, arbiter_count:1});
    RS.startSet(true, function(err, result) {      
      if(err != null) throw err;
      // Finish setup
      callback();              
    });      
  } else {    
    RS.restartKilledNodes(function(err, result) {
      if(err != null) throw err;
      callback();        
    })
  }
}

/**
 * Retrieve the server information for the current
 * instance of the db client
 * 
 * @ignore
 */
exports.tearDown = function(callback) {
  numberOfTestsRun = numberOfTestsRun - 1;
  if(numberOfTestsRun == 0) {
    // Finished kill all instances
    RS.killAll(function() {
      callback();              
    })
  } else {
    callback();            
  }  
}

exports.shouldReadPrimary = function(test) {
  // Replica configuration
  var replSet = new ReplSetServers( [ 
      new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
    ], 
    {rs_name:RS.name, read_secondary:true}
  );

  // Insert some data
  var db = new Db('integration_test_', replSet, {w:0});
  db.open(function(err, p_db) {
    var waitForSetup = function() {
      if(Object.keys(p_db.serverConfig._state.secondaries).length == 0) {
        setTimeout(waitForSetup, 1000);
      } else {
        if(err != null) debug("shouldReadPrimary :: " + inspect(err));
        // Drop collection on replicaset
        p_db.dropCollection('testsets', function(err, r) {
          if(err != null) debug("shouldReadPrimary :: " + inspect(err));
          test.equal(false, p_db.serverConfig.isReadPrimary());
          test.equal(false, p_db.serverConfig.isPrimary());
          p_db.close();
          test.done();
        });              
      }
    }
    
    setTimeout(waitForSetup, 1000);
  })                
}

exports.shouldCorrectlyTestConnection = function(test) {
  // Replica configuration
  var replSet = new ReplSetServers( [ 
      new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
    ], 
    {rs_name:RS.name, read_secondary:true}
  );

  // Insert some data
  var db = new Db('integration_test_', replSet, {w:0});
  db.open(function(err, p_db) {
    var waitForSetup = function() {
      if(Object.keys(p_db.serverConfig._state.secondaries).length == 0) {
        setTimeout(waitForSetup, 1000);
      } else {
        if(err != null) debug("shouldReadPrimary :: " + inspect(err));
        // Drop collection on replicaset
        p_db.dropCollection('testsets', function(err, r) {
          if(err != null) debug("shouldReadPrimary :: " + inspect(err));

          test.ok(p_db.serverConfig.primary != null);
          test.ok(p_db.serverConfig.read != null);
          test.ok(p_db.serverConfig.primary.port != p_db.serverConfig.read.port);
          p_db.close();
          test.done();
        });
      }
    }
    
    setTimeout(waitForSetup, 1000);
  })
}

exports.shouldCorrectlyQuerySecondaries = function(test) {
  var self = this;
  // Replica configuration
  var replSet = new ReplSetServers( [ 
      new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
      new Server( RS.host, RS.ports[1], { auto_reconnect: true } ),
      new Server( RS.host, RS.ports[2], { auto_reconnect: true } ),
    ], 
    {rs_name:RS.name, read_secondary:true}
  );

  // Insert some data
  var db = new Db('integration_test_', replSet, {w:0});
  db.open(function(err, p_db) {
    p_db.createCollection("testsets", {safe:{w:2, wtimeout:10000}}, function(err, collection) {
      collection.insert([{a:20}, {a:30}, {a:40}], {safe:{w:2, wtimeout:10000}}, function(err, result) {
        // Ensure replication happened in time
        setTimeout(function() {
          // Kill the primary
          RS.killPrimary(2, function(node) {
            collection.find().toArray(function(err, items) {                
              test.equal(null, err);
              test.equal(3, items.length);                
              p_db.close();
              test.done();
            });
          });
        }, 2000);
      })
    });      
  })    
}

exports.shouldCorrectlyQueryPrimary = function(test) {
  // debug("=========================================== shouldCorrectlyQuerySecondaries")
  var self = this;
  // Replica configuration
  var replSet = new ReplSetServers( [ 
      new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
      new Server( RS.host, RS.ports[1], { auto_reconnect: true } ),
      new Server( RS.host, RS.ports[2], { auto_reconnect: true } ),
    ], 
    {rs_name:RS.name, read_secondary:false}
  );

  // Insert some data
  var db = new Db('integration_test_', replSet, {w:0});
  db.open(function(err, p_db) {
    if(err != null) debug("shouldReadPrimary :: " + inspect(err));
    
    // Ensure the checkoutReader gives us the actual writer object
    var reader = replSet.checkoutReader();
    var writer = replSet.checkoutWriter();
    // Ensure the connections are the same
    test.equal(reader.socketOptions.host, writer.socketOptions.host);
    test.equal(reader.socketOptions.port, writer.socketOptions.port);
    // Close connection to Spain
    db.close();
    test.done();
  });
}

exports.shouldAllowToForceReadWithPrimary = function(test) {
  // debug("=========================================== shouldAllowToForceReadWithPrimary")
  // Replica configuration
  var replSet = new ReplSetServers( [ 
      new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
    ], 
    {rs_name:RS.name, read_secondary:true}
  );

  // Insert some data
  var db = new Db('integration_test_', replSet, {w:0});
  db.open(function(err, p_db) {
    if(err != null) debug("shouldReadPrimary :: " + inspect(err));
    // Create a collection
    p_db.createCollection('shouldAllowToForceReadWithPrimary', function(err, collection) {
      test.equal(null, err);
      // Insert a document
      collection.insert({a:1}, {safe:{w:2, wtimeout:10000}}, function(err, result) {
        test.equal(null, err);
        
        // Force read using primary
        var cursor = collection.find({}, {read:'primary'})            
        // Get documents
        cursor.toArray(function(err, items) {
          test.equal(1, items.length);          
          test.equal(1, items[0].a);
          p_db.close();
          test.done();
        })
      });
    })
  })                
}

exports.shouldWorkWithSecondarySeeding = function(test) {
  // debug("=========================================== shouldAllowToForceReadWithPrimary")
  // Replica configuration
  var replSet = new ReplSetServers( [ 
      new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
    ], 
    {rs_name:RS.name, read_secondary:true}
  );

  // Insert some data
  var db = new Db('integration_test_', replSet, {w:0});
  db.on("fullsetup", function() {
    // Create a collection
    db.createCollection('shouldWorkWithSecondarySeeding', function(err, collection) {
      test.equal(null, err);
      // Insert a document
      collection.insert({a:1}, {safe:{w:2, wtimeout:10000}}, function(err, result) {
        test.equal(null, err);
        
        // Force read using primary
        var cursor = collection.find({}, {read:'primary'})            
        // Get documents
        cursor.toArray(function(err, items) {
          test.equal(1, items.length);          
          test.equal(1, items[0].a);
          db.close();
          test.done();
        });
      });
    })
  });

  db.open(function(err, p_db) {
    if(err != null) debug("shouldReadPrimary :: " + inspect(err));
    db = p_db;
  })                
}

/**
 * Retrieve the server information for the current
 * instance of the db client
 * 
 * @ignore
 */
exports.noGlobalsLeaked = function(test) {
  var leaks = gleak.detectNew();
  test.equal(0, leaks.length, "global var leak detected: " + leaks.join(', '));
  test.done();
}

/**
 * Retrieve the server information for the current
 * instance of the db client
 * 
 * @ignore
 */
var numberOfTestsRun = Object.keys(this).length - 2;
















