/**
 * @license
 *
 * Copyright 2018 Google Inc.
 * https://github.com/NeilFraser/CodeCity
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Infrastructure to save the state of an Interpreter as
 *     eval-able JS.  Mainly a wrapper around Dumper, handling
 *     the application of a dupmp configuration.
 * @author cpcallen@google.com (Christohper Allen)
 */
'use strict';

var code = require('./code');
var {Dumper, Do} = require('./dumper');
var fs = require('fs');
var Interpreter = require('./interpreter');
var path = require('path');
var Selector = require('./selector');

/**
 * Dump an Interpreter using a given dump specification.
 * @param {!Interpreter} intrp The interpreter to dump.
 * @param {!Array<ConfigEntry>} config The dump specification.
 * @param {string=} directory A directory relative to which
 *     non-absolute filenames in config should be written.  If none is
 *     supplied then they will be treated as relative to the current
 *     directory.
 */
var dump = function(intrp, config, directory) {
  var dumper = new Dumper(new Interpreter(), intrp);

  // Skip everything that's explicitly mentioned in the config, so
  // that paths won't get dumped until it's their turn.
  for (var entry, i = 0; entry = config[i]; i++) {
    if (!entry.contents) continue;
    for (var item, j = 0; item = entry.contents[j]; j++) {
      dumper.markBinding(item.selector, Do.SKIP);
    }
  }
  // Dump the specified paths, in order.
  for (var entry, i = 0; entry = config[i]; i++) {
    var filename = entry.filename;
    if (directory !== undefined && !path.isAbsolute(filename)) {
      filename = path.normalize(path.join(directory, filename));
    }
    var outputStream = fs.createWriteStream(filename, {mode: 0o600});
    dumper.setOutputStream(outputStream);
    dumper.write('////////////////////////////////////////',
                 '///////////////////////////////////////\n',
                 '// ', entry.filename, '\n\n');
    if (entry.contents) {
      for (var item, j = 0; item = entry.contents[j]; j++) {
        try {
          dumper.dumpBinding(item.selector, item.do);
          dumper.write('\n');
        } catch (e) {
          dumper.write('// ', String(e), '\n');
          dumper.write(e.stack.split('\n')
              .map(function (s) {return '//     ' + s + '\n';}));
        }
      }
    } else if (entry.rest) {
      var globalScopeDumper = dumper.getScopeDumper(intrp.global);
      globalScopeDumper.dump(dumper);
    }
    outputStream.end();
  }
};

/**
 * Convert a dump plan from an !Array<!SpecEntry> to
 * !Array<!ConfigEntry>, with validataion and a few conversions:
 *
 * - Whereas as a SpecContentsEntry has a string-valued .path (which
 *   should be a selector string), the corresponding ContentsEntry
 *   will have a Selector-valued .selector.
 *
 * - Whereas the input will specify do: values as strings
 *   (e.g. "RECURSE"), the output will have Do enum values
 *   (e.g. Do.RECURSE) instead.
 *
 * - A plain selector string s, appearing in the contents: array of a
 *   SpecEntry, will be replaced by the ContentEntry
 *   {selector: new Selector(s), do: Do.RECURSE, reorder: false}.
 *
 * - All optional boolean-valued properties will be normalised to
 *   exist, defaulting to false.
 *
 * @param {*} spec The dump plan to be validated.  If this is not an
 *     !Array<!SpecEntry>, TypeError will be thrown.
 * @return {!Array<!ConfigEntry>}
 */
var configFromSpec = function(spec) {
  var /** !Array<ConfigEntry> */ config = [];

  /** @type {function(string, number=)} */
  function reject(message, j) {
    var prefix = 'spec[' + i + ']';
    if (j !== undefined) prefix = prefix + '.contents[' + j + ']';
    if (message[0] !== '.') prefix = prefix + ' ';
    throw new TypeError(prefix + message);
  }

  if (!Array.isArray(spec)) {
    throw new TypeError('spec must be an array of SpecEntries');
  }
  for (var i = 0; i < spec.length; i++) {
    var entry = spec[i];
    var /** !Array<!ContentEntry> */ contents = [];

    if (typeof entry !== 'object' || entry === null) {
      reject('not a SpecEntry object');
    } else if (typeof entry.filename !== 'string') {
      // TODO(cpcallen): add better filename validity check?
      reject('.filename is not a string');
    } else if (!Array.isArray(entry.contents) && entry.contents !== undefined) {
      reject('.contents is not an array');
    } else if (typeof entry.rest !== 'boolean' && entry.rest !== undefined) {
      reject('.rest is not a boolean');
    } else if (entry.contents) {
      for (var j = 0; j < entry.contents.length; j++) {
        var item = entry.contents[j];

        if (typeof item === 'string') {
          var selector = new Selector(item);
          contents.push({selector: selector, do: Do.RECURSE, reorder: false});
          continue;
        } else if (typeof item !== 'object' || item === null) {
          reject('not a SpecContentEntry object', j);
        } else if (typeof item.path !== 'string') {
          reject('.path not a vaid selector string', j);
        } else if (!Do.hasOwnProperty(item.do)) {
          reject('.do: ' + item.do + ' is not a valid Do value', j);
        } else if (typeof item.reorder !== 'boolean' &&
                   item.reorder !== undefined) {
          reject('.reorder must be boolean or omitted', j);
        }
        contents.push({
          selector: new Selector(item.path),
          do: Do[item.do],
          reorder: Boolean(item.reorder),
        });
      }
    } else if (!entry.rest) {
      throw new TypeError(
          'spec[' + i + '] must specify one of .contents or .rest');
    }

    config.push({
      filename: entry.filename,
      contents: contents,  // Possibly empty.
      rest: Boolean(entry.rest),
    });
  }
  return config;
};

///////////////////////////////////////////////////////////////////////////////
// Data types used to specify a dump configuration.

/**
 * A processed-and-ready-to-use configuration entry for a single
 * output file.
 * @typedef {{filename: string,
 *            contents: !Array<!ContentEntry>,
 *            rest: boolean}}
 */
var ConfigEntry;

/**
 * The type of the values of .contents entries of a ConfigEntry.
 * @record
 */
var ContentEntry = function() {};

/**
 * Selector is a Selector instance (e.g. created from a selector string
 * like "eval", "Object.prototype" or "$.util.command") identifying
 * the variable or property binding this entry applies to.
 * @type {!Selector}
 */
ContentEntry.prototype.selector;

/**
 * Do is what to to do with the specified path.
 * @type {!Do}
 */
ContentEntry.prototype.do;

/**
 * Reorder is a boolean specifying whether it is acceptable to allow
 * property or set/map entry entries to be created (by the output JS)
 * in a different order than they apear in the interpreter instance
 * being serialised.  If false, output may contain placeholder entries
 * like:
 *
 *     var obj = {};
 *     obj.foo = undefined;  // placeholder
 *     obj.bar = function() { ... };
 *
 * to allow obj.foo to be defined later while still preserving
 * property order.
 * @type {boolean}
 */
ContentEntry.prototype.reorder;

/**
 * A configuration entry represented as plain old JavaScript object
 * (i.e., as ouptut by JSON.parse).  Do values are reprsesented by the
 * coresponding strings (e.g., "RECURSE" instead of Do.RECURSE), while
 * content items can be just a selector string, which will be dumped
 * recursively.
 *
 * @typedef {{filename: string,
 *            contents: (!Array<string|!SpecContentEntry>|undefined),
 *            rest: (boolean|undefined)}}
 */
var SpecEntry;

/**
 * Like a ContentEntry, but with a string instead of a Do value.
 * @typedef {{path: string,
 *            do: string,
 *            reorder: (boolean|undefined)}}
 */
var SpecContentEntry;

///////////////////////////////////////////////////////////////////////////////
// Exports.

exports.configFromSpec = configFromSpec;
exports.Do = Do;
exports.dump = dump;
