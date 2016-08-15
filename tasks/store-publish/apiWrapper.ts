﻿/*
 * A helper for the Store API. Allows one to authenticate and perform requests through the API.
 */

/// <reference path="../../typings/globals/form-data/index.d.ts" />
/// <reference path="../../typings/globals/node-uuid/node-uuid-base/index.d.ts" />
/// <reference path="../../typings/globals/node-uuid/node-uuid-cjs/index.d.ts" />
/// <reference path="../../typings/globals/node-uuid/index.d.ts" />
/// <reference path="../../typings/globals/q/index.d.ts" />
/// <reference path="../../typings/globals/request/index.d.ts" />

import http = require('http'); // Only used for types

import uuid = require('node-uuid');
import Q = require('q');
import request = require('request');
var streamifier = require('streamifier'); // streamifier has no typings

/** How long to wait between retries (in ms) */
const RETRY_DELAY = 5000;

/** After how long should a connection be given up (in ms). */
const TIMEOUT = 180000;

/** Block size of chunks uploaded to the blob (in bytes). */
const UPLOAD_BLOCK_SIZE_BYTES = 1024 * 1024; // 1Mb

/** Credentials used to gain access to a particular resource. */
export interface Credentials
{
    /** The tenant ID associated with these credentials. */
    tenant: string;

    clientId: string;
    clientSecret: string;
}

/** A token used to access a particular resource. */
export interface AccessToken
{
    /** Resource to which this token grants access. */
    resource: string

    /** Credentials used to obtain access. */
    credentials: Credentials;

    /** Expiration timestamp of the token */
    expiration: number;

    /** Actual token to be used in the request. */
    token: string;
}

/** Whether an access token should be renewed. */
function isExpired(token: AccessToken): boolean
{
    // Date.now() returns a number in miliseconds.
    // We say that a token is expired if its expiration date is at most five seconds in the future.
    return (Date.now() / 1000) + 5 > token.expiration;
}

/** All the information given to us by the request module along a response. */
export class ResponseInformation
{
    error: any;
    response: http.IncomingMessage;
    body: any;

    constructor(_err: any, _res: http.IncomingMessage, _bod: any) 
    {
        this.error = _err;
        this.response = _res;
        this.body = _bod;
    }

    // For friendly logging
    toString(): string
    {
        if (this.error != undefined)
        {
            return `Error ${JSON.stringify(this.error)}`;
        }
        else
        {

            var bodyToPrint = this.body;
            if (typeof bodyToPrint != 'string')
            {
                bodyToPrint = JSON.stringify(bodyToPrint);
            }

            return `Status ${this.response.statusCode}: ${bodyToPrint}`;
        }
    }
}

/**
 * Perform a request with some default handling.
 *
 * For convenience, parses the body if the content-type is 'application/json'.
 * Further, examines the body and logs any errors or warnings.
 *
 * If an transport or application level error occurs, rejects the returned promise.
 * The reason given is an instance of @ResponseInformation@, containing the error
 * object, the response and the body.
 *
 * If no error occurs, resolves the returned promise with the body.
 *
 * @param options Options describing the request to execute.
 */
export function performRequest<T>(options: (request.UriOptions | request.UrlOptions) & request.CoreOptions):
    Q.Promise<T>
{
    var deferred = Q.defer<T>();

    if (options.timeout == undefined)
    {
        options.timeout = TIMEOUT;
    }

    request(options, function (error, response, body)
    {
        // For convenience, parse the body if it's JSON.
        if (response != undefined && // response is undefined if a transport-level error occurs
            response.headers['content-type'] != undefined &&   // content-type is undefined if there is no content
            response.headers['content-type'].indexOf('application/json') != -1 &&
            typeof body == 'string') // body might be an object if the options given to request already parsed it for us
        {
            body = JSON.parse(body);
            logErrorsAndWarnings(body);
        }

        if (error || (response && response.statusCode >= 400))
        {
            deferred.reject(new ResponseInformation(error, response, body));
        }
        else
        {
            deferred.resolve(body);
        }
    });

    return deferred.promise;
}

/**
 * Same as @performRequest@, but additionally requires an authentification token.
 * @param auth A token used to identify with the resource. If expired, it will be renewed before executing the request.
 */
export function performAuthenticatedRequest<T>(
    auth: AccessToken,
    options: (request.UriOptions | request.UrlOptions) & request.CoreOptions):
    Q.Promise<T>
{
    // The expiration check is a function that returns a promise
    var expirationCheck = function ()
    {
        if (isExpired(auth))
        {
            return authenticate(auth.resource, auth.credentials).then(function (newAuth)
            {
                auth.token = newAuth.token;
                auth.expiration = newAuth.expiration;
            });
        }
        else
        {
            /* This looks strange, but it returns a promise for void, which is exactly what we need. */
            return Q.when();
        }
    };


    return expirationCheck() // Call the expiration check to obtain a promise for it.
        .then<T>(function () // Chain the use of the token to that promise.
        {
            if (options.headers === undefined)
            {
                options.headers = {
                    'Authorization': 'Bearer ' + auth.token
                }
            }
            else
            {
                options.headers['Authorization'] = 'Bearer ' + auth.token;
            }

            return performRequest<T>(options);
        });
}

/**
 * @param resource The resource (URL) to authenticate to.
 * @param credentials Credentials to use for authentication.
 * @returns Promises an access token to use to communicate with the resource.
 */
export function authenticate(resource: string, credentials: Credentials): Q.Promise<AccessToken>
{
    var endpoint = 'https://login.microsoftonline.com/' + credentials.tenant + '/oauth2/token';
    var requestParams = {
        grant_type: 'client_credentials',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        resource: resource
    };

    var options = {
        url: endpoint,
        method: 'POST',
        form: requestParams
    };

    console.log('Authenticating with server...');
    return performRequest<any>(options).then<AccessToken>(body =>
    {
        var tok: AccessToken = {
            resource: resource,
            credentials: credentials,
            expiration: body.expires_on,
            token: body.access_token
        };

        return tok;
    });
}

/**
 * Transforms a promise so that it is tried again a specific number of times if it fails.
 *
 * A 'generator' of promises must be supplied. The reason is that if a promise fails,
 * then it will stay in a failed state and it won't be possible to await on it anymore.
 * Therefore a new promise must be returned every time.
 *
 * @param numRetries How many times should the promise be tried to be fulfilled.
 * @param promiseGenerator A function that will generate the promise to try to fulfill.
 * @param errPredicate In case an error occurs, receives the reason and returns whether to continue retrying
 */
export function withRetry<T>(
    numRetries: number,
    promiseGenerator: () => Q.Promise<T>,
    errPredicate?: ((err: any) => boolean)): Q.Promise<T>
{
    return promiseGenerator().fail(err =>
    {
        if (numRetries > 0 && (!errPredicate || errPredicate(err)))
        {
            console.log(`Operation failed with ${err}`);
            console.log(`Waiting ${RETRY_DELAY / 1000} seconds then retrying... (${numRetries - 1} retrie(s) left)`);
            return Q.delay(RETRY_DELAY).then(() => withRetry(numRetries - 1, promiseGenerator, errPredicate));
        }
        else
        {
            /* Don't wrap err in an error because it's already an error
            (.fail() is the equivalent of "catch" for promises) */
            throw err;
        }
    });
}

export function uploadAzureFile(fileContents: Buffer, blobUrl: string): Q.Promise<void>
{
    return uploadAzureFileBlocks(fileContents, blobUrl).then(blockList =>
    {
        console.log(blockList);

        var options = {
            url: blobUrl + '&comp=blocklist',
            body: blockList,
            method: 'PUT'
        }

        return performRequest<void>(options);
    });
}

/**
 * Uploads a file chunk by chunk to the given Azure blob.
 * @return A promise for the list of chunks uploaded, in a format understood by the Azure API
 */
function uploadAzureFileBlocks(fileContents: Buffer, blobUrl: string): Q.Promise<string>
{
    var requestParams = {
        headers: {
            'x-ms-blob-type': 'BlockBlob'
        }
    }
    var deferred = Q.defer<string>();

    var numBlocks = Math.ceil(fileContents.length / UPLOAD_BLOCK_SIZE_BYTES);
    const fileGuid = uuid.v4().replace(/\-/g, '');
    var currentBlockId = 0;
    var numBlocksFinished = 0;

    // This XML is a flat structure so we can get away with just dealing with strings
    var blockListXml = '<?xml version="1.0" encoding="utf-8"?><BlockList>';

    var fileStream = streamifier.createReadStream(fileContents);
    fileStream.on('readable', () =>
    {
        var block: string | Buffer;

        while ((block = fileStream.read(UPLOAD_BLOCK_SIZE_BYTES)) !== null)
        {
            var thisBlockId = currentBlockId++;

            requestParams.headers['content-length'] = block.length;

            // Sequence number with leading zeros.
            // Note: will not work if we need more than a million blocks
            // Note 2: with current block size, a million blocks is one terabyte.
            var sequence = ('000000' + thisBlockId).substr(-6);
            var base64Id = new Buffer(fileGuid + '-' + sequence).toString('base64');
            var thisBlockUrl = blobUrl + '&comp=block&blockid=' + base64Id;

            blockListXml += '<Latest>' + base64Id + '</Latest>';

            console.log(`\tUploading block ${thisBlockId} (ID ${base64Id})`);

            /* When doing a multipart form request, the request module erroneously (?) adds some headers like
             * content-disposition to the __contents__ of the data, which corrupts the file. Therefore we have
             * to use this instead, where the block is piped from a stream to the put request. */
            streamifier.createReadStream(block)
                .pipe(request.put(thisBlockUrl, requestParams, function (err, resp, body)
                {
                    if (err)
                    {
                        deferred.reject(err);
                    }
                    else if (resp.statusCode >= 400)
                    {
                        deferred.reject(new Error(`Status: ${resp.statusCode}. Body: ${JSON.stringify(body)}`));
                    }
                    else
                    {
                        console.log(`\tUploaded block ${thisBlockId} (ID ${base64Id})`);
                        numBlocksFinished++;
                        if (numBlocksFinished == numBlocks)
                        {
                            deferred.resolve(blockListXml + '</BlockList>');
                        }
                    }
                }));
        }
    });

    return deferred.promise;
}


/** 
 * Examines a response body and logs errors and warnings.
 * @param body A body in the format given by the Store API
 * (Where body.errors and body.warnings are arrays of objects
 * containing a 'code' and 'details' attribute).
 */
function logErrorsAndWarnings(body: any)
{
    if (body.errors != undefined && body.errors.length > 0)
    {
        console.error('Errors occurred in request');
        (<any[]>body.errors).forEach(x => console.error(`\t[${x.code}]  ${x.details}`));
    }

    if (body.warnings != undefined && body.warnings.length > 0)
    {
        console.warn('Warnings occurred in request');
        (<any[]>body.warnings).forEach(x => console.warn(`\t[${x.code}]  ${x.details}`));
    }
}

