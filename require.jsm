'use strict';

const EXPORTED_SYMBOLS = ['Requirer'];
const exports = {Requirer: Requirer};

// noinspection JSUnresolvedVariable
const Cu = Components.utils;
// noinspection JSUnresolvedVariable
const Ci = Components.interfaces;
// noinspection JSUnresolvedVariable
const Cc = Components.classes;

const SEP = '/';
const UP = '..';
const HERE = '.';

function require(id) {
    return Cu.import(id.replace('gre/', 'resource://gre/modules/'), {});
}

const Services = require('gre/Services.jsm').Services;
const ConsoleAPI = require('gre/devtools/Console.jsm').ConsoleAPI;
const console = new ConsoleAPI({consoleID: ''});
// noinspection JSUnresolvedVariable
const NetUtil = require('gre/NetUtil.jsm').NetUtil;

// FIXME: not higher than _root
function Module(id, uri) {
    this.id = id;
    this.uri = uri;
    this.deps = {};
    this.exports = null;
    let lastIndex = uri.lastIndexOf(SEP);
    if (lastIndex === -1) {
        lastIndex = uri.length;
    }
    this.dirname = uri.substring(0, lastIndex);
}

Module.prototype.createChild = function (id, uri) {
    this.setChild(id, new Module(id, uri));
    return this.deps[id];
};

Module.prototype.setChild = function (id, mdl) {
    if (!this.deps[id]) {
        this.deps[id] = mdl;
        return this;
    }
    if (this.deps[id] !== mdl) {
        throw new Error('Module ' + this.uri + ' already have other depency with id ' + id);
    }
    return this;
};

const PROTOCOL_RE = /^\w+:\/\//;
function getProtocol(path) {
    let res = PROTOCOL_RE.exec(path);
    return res && res[0] || '';
}

function Requirer(root) {
    this._cache = {};
    this._alias = {};
    this._exists = {};
    this._globals = {};

    if (root[root.length - 1] !== SEP) {
        root += SEP;
    }
    this._protocol = getProtocol(root);
    // path module shouldn't understand protocols
    this._root = this._unabs(root);

    this.EXT_MAP = {
        '.js': this._loadJS,
        '.jsm': this._loadJSM,
        '.json': this._loadJSON,
    };
}

Requirer.prototype = {
    get global() {
        return this._globals;
    }
};

Requirer.prototype.setGlobals = function (globals) {
    this._globals = globals;
    return this;
};

Requirer.prototype.alias = function (aliasId, handler) {
    this._alias[aliasId] = handler;
    return this;
};

Requirer.prototype.aliasPath = function (aliasId, aliasPath) {
    if (aliasId.endsWith(SEP)) {
        return this.alias(aliasId, function (subpath, claimer) {
            let id = aliasId + subpath;
            delete claimer.deps[id]; // rewrite child
            let uri = aliasPath + subpath;
            return this._getModule(claimer, id, uri, this._load).exports;
        }, this); // 'this' is just for editor
    }

    return this.alias(aliasId, function (subpath, claimer) {
        this.remove(aliasId); // prevent infinite recursion
        this._cache[aliasId] = this._require(claimer, aliasPath).exports;
        this._alias[aliasId] = null; // it's in cache, we need only key to check
        return this._cache[aliasId];
    }, this);
};

Requirer.prototype.aliasModule = function (id, mdl) {
    this._alias[id] = function () {
        return mdl;
    };
    return this;
};

Requirer.prototype.remove = function (id) {
    delete this._alias[id];
    delete this._cache[id];
    return this;
};

Requirer.prototype.main = function (path) {
    return this._require(new Module('', this._root), path).exports;
};

function swp(uri, foo, bar) {
    return uri.indexOf(foo) === 0
        ? uri.replace(foo, bar)
        : uri;
}

Requirer.prototype._unabs = function (uri) {
    return swp(uri, this._protocol, SEP);
};

Requirer.prototype.revertPath = function (uri) {
    return this._abs(unifySep(uri));
};

Requirer.prototype._abs = function (uri) {
    return swp(uri, SEP, this._protocol);
};

function extname(uri) {
    var slashIndex = uri.lastIndexOf(SEP);
    if (slashIndex > -1 && slashIndex < uri.lastIndexOf('.')) {
        return '.' + uri.split(SEP).pop().split('.').pop();
    }
    return '';
}

/*
 * HELPERS
 */
Requirer.prototype._load = function (mdl) {
    let ext = extname(mdl.uri);
    let load = this.EXT_MAP[ext];
    if (!load) {
        throw new Error('File type "' + ext + '" isn\'t supported.');
    }
    let absUrl = this._abs(mdl.uri);
    return load.call(this, absUrl, mdl);
};

function readURI(uri) {
    let charset = 'UTF-8';
    let stream = NetUtil.newChannel(uri, charset, null).open();
    let count = stream.available();
    let data = NetUtil.readInputStreamToString(stream, count, {charset: charset});
    stream.close();
    return data;
}

Requirer.prototype._loadJSON = function (uri) {
    return JSON.parse(readURI(uri));
};

Requirer.prototype._loadJSM = function (uri) {
    return Cu.import(uri, {});
};

Requirer.prototype._loadJS = function (uri, mdl) {
    let sbx = this._createSandbox(mdl);
    Services.scriptloader.loadSubScript(uri, sbx);
    return sbx.module.exports;
};

Requirer.prototype._createSandbox = function (mdl) {
    // TODO: globals.process
    let globals = Object.create(this._globals);
    globals.__dirname = mdl.dirname;
    globals.__filename = mdl.uri;
    globals.require = function (id) {
        return this._require(mdl, id).exports;
    }.bind(this);

    let xprt = Object.create(null);
    globals.exports = xprt;
    globals.module = {
        exports: xprt,
        filename: globals.__filename,
        require: globals.require,
    };
    return globals;
};

const resProtocolHandler = Cc['@mozilla.org/network/protocol;1?name=resource']
    .getService(Ci.nsIResProtocolHandler);

function isExists(path) {
    try {
        let uri = Services.io.newURI(path, null, null);

        if (uri.scheme === 'resource') {
            uri = Services.io.newURI(resProtocolHandler.resolveURI(uri), null, null);
            Services.io.newChannelFromURI(uri).open().close();
            return true;
        } else {
            uri.QueryInterface(Ci.nsIFileURL);
            return Boolean(uri.file);
        }
    } catch (e) {}

    return false;
}

function findEntryPoint(path, extMap) {
    let ext = extname(path);
    if (ext in extMap) {
        if (isExists(path)) {
            return path;
        }
        throw new Error('File does not exists ' + path);
    }

    let testPath = path + '.js';
    if (isExists(testPath)) {
        return testPath;
    }

    testPath = path + SEP + 'index.js';
    if (path && isExists(testPath)) {
        return testPath;
    }

    throw new Error('No entry point for path ' + path + ' in dir ' + path);
}

function join(dir, path) {
    let parts = [];
    let i = 0;
    // TODO: work with protocol
    let arr = (dir + SEP + path).split(SEP);
    let ln = arr.length;
    while (i < ln) {
        let part = arr[i++];
        if (/*!part || */part === HERE) {
            continue;
        }
        if (part === UP) {
            if (!parts.pop()) {
                throw new Error('Invalid relative path: ' + path + ' in ' + dir);
            }
            continue;
        }
        parts.push(part);
    }
    return parts.join(SEP);
}

Requirer.prototype._resolve = function (dir, subpath) {
    let path = subpath.indexOf(SEP) === 0
        ? subpath
        : join(dir, subpath);
    path = this._abs(path);
    return this._unabs(findEntryPoint(path, this.EXT_MAP));
};
/**
 * @param path
 * @return {*}
 */
Requirer.prototype._isExists = function (path) {
    if (path in this._exists) {
        return this._exists[path];
    }
    this._exists[path] = isExists(this._abs(path));
    return this._exists[path];
};

const MODULES_DIRNAME = 'node_modules';
/**
 * @param {String} dirname
 * @return {Array}
 * @private
 */
function getPathsToSearch(dirname) {
    let parts = dirname.split(SEP);
    let dirs = [];
    let part;
    while (parts.length) {
        part = parts.pop();
        if (part !== MODULES_DIRNAME) {
            dirs.push(
                parts.concat([part, MODULES_DIRNAME]).join(SEP)
            );
        }
    }
    return dirs;
}

/**
 * @param {String} dirname path that is relative to root (begins with './')
 * @param {String} moduleName module name: name of directory
 * @return {String?}
 * @private
 */
Requirer.prototype._findNodeModuleDir = function (dirname, moduleName) {
    // check for local modules first
    let paths = getPathsToSearch(dirname.replace(this._root, './')).map(function (path) {
        return path.replace('./', this._root);
    }, this);

    let moduleDir = ''; // dir of required module
    let isFound = paths.some(function (path) {
        // is cached, so check for ./foo/node_modules first
        if (!this._isExists(path)) {
            return false;
        }
        moduleDir = path + SEP + moduleName;
        // ./foo/node_modules/mymodule
        return this._isExists(moduleDir);
    }, this);
    return isFound ? moduleDir : null;
};

/**
 * @param {Module} claimer parent module
 * @param {String} id local id, the one claimer used
 * @param {String} globId global id (like fullpath or uri): resolved id value
 * @param {Function} fn module exports getter
 * @return {Module}
 * @private
 */
Requirer.prototype._getModule = function (claimer, id, globId, fn) {
    if (id in claimer.deps) {
        return claimer.deps[id];
    }

    let mdl = claimer.createChild(id, globId);
    let cached = this._cache[globId];
    if (!cached) {
        cached = fn.call(this, mdl);
        this._cache[globId] = cached;
    }
    mdl.exports = cached;
    return mdl;
};

/**
 * @param {String} aliasId
 * @param {String} subpath
 * @param {Module} claimer
 * @return {*}
 * @private
 */
Requirer.prototype._callAlias = function (aliasId, subpath, claimer) {
    return this._alias[aliasId].call(this, subpath, claimer, aliasId);
};

/**
 * @param {String} id
 * @return {String?}
 * @private
 */
Requirer.prototype._findAlias = function (id) {
    if (id in this._alias) {
        return id;
    }

    let aliasId = '';
    let isAliasFound = Object.keys(this._alias).some(function (key) {
        aliasId = key;
        // for cases when 'abc' intercepts 'abcde':
        // path expanders should be with trailing sep
        return key.endsWith(SEP) && id.startsWith(key);
    });
    return isAliasFound ? aliasId : null;
};

const UP_SEP = UP + SEP;
const HERE_SEP = HERE + SEP;
function isPath(id) {
    return id.indexOf(HERE_SEP) === 0
        || id.indexOf(UP_SEP) === 0
        || id.indexOf(SEP) === 0
        || PROTOCOL_RE.test(id);
}

function unifySep(id) {
    return id.split('\\').join(SEP);
}

/**
 *
 * @param {Module} claimer
 * @param {String} id
 * @return {Module}
 * @private
 */
Requirer.prototype._require = function (claimer, id) {
    id = unifySep(id);

    // it could be path
    if (isPath(id)) {
        let uri = this._resolve(claimer.dirname, id);
        if (!uri.startsWith(this._root)) {
            throw new Error([
                'It is forbidden to require module outside of root directory.',
                'id: ' + id,
                'from: ' + claimer.uri,
                'root path: ' + this._root,
                'uri: ' + uri
            ].join('\n'));
        }
        return this._getModule(claimer, id, uri, this._load);
    }

    // or alias
    let aliasId = this._findAlias(id);
    if (aliasId) {
        return this._getModule(claimer, id, id, function () {
            return this._callAlias(aliasId, id.substring(aliasId.length), claimer);
        });
    }

    // or npm module
    // you can request file from inside packed module (subfile)
    let sepIndex = id.indexOf(SEP);
    let moduleName = id;
    let subpath = null;

    if (sepIndex > -1) {
        moduleName = id.substring(0, sepIndex);
        subpath = id.substring(sepIndex + 1);
        // TODO: throw on require('module/../foo.js');
    }

    let moduleDir = this._findNodeModuleDir(claimer.dirname, moduleName);
    if (moduleDir == null) {
        throw new Error([
            'Module "' + id + '" is not found',
            'from: ' + claimer.uri,
        ].join('\n'));
    }

    if (!subpath) {
        // if it is not a link to specific file,
        // we should read package.json fo find entry point file
        let pkgPath = moduleDir + SEP + 'package.json';
        let pkg = this._load(new Module(pkgPath, pkgPath));
        // it could be required inside of the module
        this._cache[pkgPath] = pkg;
        subpath = pkg.main || 'index.js';
        // I think there is no need to preload dependencies
    }

    let uri = this._resolve(moduleDir, subpath);
    return this._getModule(claimer, id, uri, this._load);
};
