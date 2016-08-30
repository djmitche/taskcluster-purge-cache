let _           = require('lodash');
let API         = require('taskcluster-lib-api');
let taskcluster = require('taskcluster-client');

// Common schema prefix
let SCHEMA_PREFIX_CONST = 'http://schemas.taskcluster.net/purge-cache/v1/';

/** API end-point for version v1/ */
let api = new API({
  title:        'Purge Cache API Documentation',
  context: [
    'cfg',              // A typed-env-config instance
    'publisher',        // A pulse-publisher instance
    'CacheBuster',      // A data.CacheBuster instance
    'cacheBusterCache', // An Promise for cacheing cachebuster responses
  ],
  description: [
    'The purge-cache service, typically available at',
    '`purge-cache.taskcluster.net`, is responsible for publishing a pulse',
    'message for workers, so they can purge cache upon request.',
    '',
    'This document describes the API end-point for publishing the pulse',
    'message. This is mainly intended to be used by tools.',
  ].join('\n'),
});

// Export API
module.exports = api;

/** Define tasks */
api.declare({
  method:     'post',
  route:      '/purge-cache/:provisionerId/:workerType',
  name:       'purgeCache',
  scopes:     [
    ['purge-cache:<provisionerId>/<workerType>:<cacheName>'],
  ],
  deferAuth:  true,
  input:      SCHEMA_PREFIX_CONST + 'purge-cache-request.json#',
  title:      'Purge Worker Cache',
  description: [
    'Publish a purge-cache message to purge caches named `cacheName` with',
    '`provisionerId` and `workerType` in the routing-key. Workers should',
    'be listening for this message and purge caches when they see it.',
  ].join('\n'),
}, async function(req, res) {
  let {provisionerId, workerType} = req.params;
  let {cacheName} = req.body;

  // Authenticate request by providing parameters, and then validate that the
  // requester satisfies all the scopes assigned to the task
  if (!req.satisfies({provisionerId, workerType, cacheName})) {
    return;
  }

  // Publish message
  await this.publisher.purgeCache({provisionerId, workerType, cacheName});

  try {
    await this.CacheBuster.create({
      workerType,
      provisionerId,
      cacheName,
      before: new Date(),
      expires: taskcluster.fromNow('1 day'),
    });
  } catch (err) {
    if (err.code !== 'EntityAlreadyExists') {
      throw err;
    }
    let cb = await this.CacheBuster.load({
      workerType,
      provisionerId,
      cacheName,
    });

    await cb.modify(cacheBuster => {
      cacheBuster.before = new Date();
      cacheBuster.expires = taskcluster.fromNow('1 day');
    });
  }

  // Return 204
  res.status(204).send();
});

api.declare({
  method:   'get',
  route:    '/purge-requests',
  query: {
    continuationToken: /./,
    limit: /^[0-9]+$/,
  },
  name:     'allPurgeRequests',
  output:   SCHEMA_PREFIX_CONST + 'purge-cache-request-list.json#',
  title:    'All Open Purge Requests',
  description: [
    'This is useful mostly for administors to view',
    'the set of open purge requests. It should not',
    'be used by workers. They should use the purgeRequests',
    'endpoint that is specific to their workerType and',
    'provisionerId.',
  ].join('\n'),
}, async function(req, res) {
  let continuation = req.query.continuationToken || null;
  let limit = parseInt(req.query.limit || 1000, 10);
  let openRequests = await this.CacheBuster.scan({}, {continuation, limit});
  return res.reply({
    cacheHit: false,
    requests: _.map(openRequests.entries, entry => {
      return {
        provisionerId: entry.provisionerId,
        workerType: entry.workerType,
        cacheName: entry.cacheName,
        before: entry.before.toJSON(),
        expires: entry.expires.toJSON(),
      };
    }),
  });
});

api.declare({
  method:   'get',
  route:    '/purge-requests/:provisionerId/:workerType',
  name:     'purgeRequests',
  output:   SCHEMA_PREFIX_CONST + 'purge-cache-request-list.json#',
  title:    'Open Purge Requests for a provisionerId/workerType pair',
  description: [
    'List of caches that need to be purged if they are from before',
    'a certain time. This is safe to be used in automation from',
    'workers.',
  ].join('\n'),
}, async function(req, res) {

  let {provisionerId, workerType} = req.params;
  let cacheKey = `${provisionerId}/${workerType}`;
  let cachedReq = this.cacheBusterCache.cacheKey;
  let cacheHit = false;
  this.cacheBusterCache[cacheKey] = Promise.resolve(this.cacheBusterCache[cacheKey]).then(async cacheCache => {
    if (cacheCache && Date.now() - cacheCache.touched < this.cfg.app.cacheTime * 1000) {
      cacheHit = true;
      return cacheCache;
    }
    return Promise.resolve({reqs: await this.CacheBuster.query({provisionerId, workerType}), touched: Date.now()});
  });
  let openRequests = await this.cacheBusterCache[cacheKey].then(cacheCache => {
    return cacheCache.reqs;
  });
  return res.reply({
    cacheHit,
    requests: _.map(openRequests.entries, entry => {
      return {
        provisionerId: entry.provisionerId,
        workerType: entry.workerType,
        cacheName: entry.cacheName,
        before: entry.before.toJSON(),
        expires: entry.expires.toJSON(),
      };
    }),
  });
});

/** Check that the server is a alive */
api.declare({
  method:   'get',
  route:    '/ping',
  name:     'ping',
  title:    'Ping Server',
  description: [
    'Documented later...',
    '',
    '**Warning** this api end-point is **not stable**.',
  ].join('\n'),
}, function(req, res) {

  res.status(200).json({
    alive:    true,
    uptime:   process.uptime(),
  });
});
