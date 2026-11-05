// `Uint8Array` hex and base64 methods from tc39/proposal-arraybuffer-base64.
// V8 130 has no native version, so the guest gets this one. A later V8 with
// native methods keeps its own: `defineMissingMethods` skips them.
//
// This file does not use `Buffer`: the methods accept any Uint8Array, and guest
// code can patch `Buffer`.

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_CHARS = `${BASE64_CHARS.slice(0, 62)}-_`;
const HEX_PAIRS = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));
const EQUALS_CODE = 61;

function createDecodeTable(chars) {
  const table = new Int8Array(128).fill(-1);
  for (let value = 0; value < chars.length; value++) {
    table[chars.charCodeAt(value)] = value;
  }
  return table;
}

const BASE64_VALUES = createDecodeTable(BASE64_CHARS);
const BASE64URL_VALUES = createDecodeTable(BASE64URL_CHARS);
const HEX_VALUES = createDecodeTable("0123456789abcdef");
HEX_VALUES.set([10, 11, 12, 13, 14, 15], "A".charCodeAt(0));

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getTypedArrayName = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArrayValues = typedArrayPrototype.values;

function assertUint8Array(value, method) {
  if (getTypedArrayName.call(value) !== "Uint8Array") {
    throw new TypeError(`Uint8Array.prototype.${method} requires a Uint8Array receiver`);
  }
}

// `values` is the shortest built-in that throws a TypeError when the buffer is
// detached or the view is out of bounds. Those views otherwise read as empty.
function assertBytesReadable(view) {
  typedArrayValues.call(view);
}

function readOptions(options) {
  if (options === undefined) return Object.create(null);
  if ((typeof options === "object" && options !== null) || typeof options === "function") {
    return options;
  }
  throw new TypeError("Uint8Array base64 options must be an object or undefined");
}

function readAlphabet(options) {
  const alphabet = options.alphabet;
  if (alphabet === undefined) return "base64";
  if (alphabet !== "base64" && alphabet !== "base64url") {
    throw new TypeError('Uint8Array base64 option "alphabet" must be "base64" or "base64url"');
  }
  return alphabet;
}

function readLastChunkHandling(options) {
  const handling = options.lastChunkHandling;
  if (handling === undefined) return "loose";
  if (handling !== "loose" && handling !== "strict" && handling !== "stop-before-partial") {
    throw new TypeError(
      'Uint8Array.fromBase64 option "lastChunkHandling" must be "loose", "strict", or "stop-before-partial"',
    );
  }
  return handling;
}

function assertString(value, method) {
  if (typeof value !== "string") {
    throw new TypeError(`Uint8Array.${method} requires a string`);
  }
}

// Forgiving-base64 whitespace. It excludes the vertical tab that `\s` accepts.
function skipBase64Whitespace(string, start) {
  let index = start;
  while (index < string.length) {
    const code = string.charCodeAt(index);
    if (code !== 9 && code !== 10 && code !== 12 && code !== 13 && code !== 32) break;
    index++;
  }
  return index;
}

function encodeBase64(bytes, chars, omitPadding) {
  const length = bytes.length;
  const fullChunksEnd = length - (length % 3);
  let encoded = "";
  for (let index = 0; index < fullChunksEnd; index += 3) {
    const bits = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    encoded += chars[bits >>> 18] + chars[(bits >>> 12) & 63] + chars[(bits >>> 6) & 63] + chars[bits & 63];
  }
  if (length - fullChunksEnd === 1) {
    const bits = bytes[fullChunksEnd];
    encoded += chars[bits >>> 2] + chars[(bits << 4) & 63];
    if (!omitPadding) encoded += "==";
  } else if (length - fullChunksEnd === 2) {
    const bits = (bytes[fullChunksEnd] << 8) | bytes[fullChunksEnd + 1];
    encoded += chars[bits >>> 10] + chars[(bits >>> 4) & 63] + chars[(bits << 2) & 63];
    if (!omitPadding) encoded += "=";
  }
  return encoded;
}

function invalidBase64() {
  return new SyntaxError("Uint8Array.fromBase64 received an invalid base64 string");
}

// Follows the spec's FromBase64 steps. `bits` holds the `chunkLength` values of
// the current chunk, so a chunk is written only when it is complete or final.
function decodeBase64(string, alphabet, lastChunkHandling) {
  const values = alphabet === "base64url" ? BASE64URL_VALUES : BASE64_VALUES;
  const length = string.length;
  const output = new Uint8Array(Math.ceil(length / 4) * 3);
  let written = 0;
  let bits = 0;
  let chunkLength = 0;
  let index = 0;

  const finish = () => output.slice(0, written);
  const writeFinalChunk = (rejectExtraBits) => {
    const extraBits = chunkLength === 2 ? bits & 15 : bits & 3;
    if (rejectExtraBits && extraBits !== 0) throw invalidBase64();
    if (chunkLength === 2) {
      output[written++] = bits >>> 4;
    } else {
      output[written++] = bits >>> 10;
      output[written++] = (bits >>> 2) & 255;
    }
  };

  for (;;) {
    index = skipBase64Whitespace(string, index);

    if (index === length) {
      if (chunkLength > 0) {
        if (lastChunkHandling === "stop-before-partial") return finish();
        if (lastChunkHandling === "strict" || chunkLength === 1) throw invalidBase64();
        writeFinalChunk(false);
      }
      return finish();
    }

    const code = string.charCodeAt(index++);

    if (code === EQUALS_CODE) {
      if (chunkLength < 2) throw invalidBase64();
      index = skipBase64Whitespace(string, index);
      if (chunkLength === 2) {
        if (index === length) {
          if (lastChunkHandling === "stop-before-partial") return finish();
          throw invalidBase64();
        }
        if (string.charCodeAt(index) === EQUALS_CODE) {
          index = skipBase64Whitespace(string, index + 1);
        }
      }
      if (index < length) throw invalidBase64();
      writeFinalChunk(lastChunkHandling === "strict");
      return finish();
    }

    const value = code < 128 ? values[code] : -1;
    if (value < 0) throw invalidBase64();
    bits = (bits << 6) | value;
    chunkLength++;

    if (chunkLength === 4) {
      output[written++] = bits >>> 16;
      output[written++] = (bits >>> 8) & 255;
      output[written++] = bits & 255;
      bits = 0;
      chunkLength = 0;
    }
  }
}

function decodeHexDigit(string, index) {
  const code = string.charCodeAt(index);
  const value = code < 128 ? HEX_VALUES[code] : -1;
  if (value < 0) {
    throw new SyntaxError("Uint8Array.fromHex received a string with a non-hex character");
  }
  return value;
}

function defineMissingMethods(target, methods) {
  for (const [name, value] of Object.entries(methods)) {
    if (typeof target[name] === "function") continue;
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
  }
}

// Methods are object-literal shorthand so they have no [[Construct]]. The
// default parameter keeps `toBase64.length` at 0, as the spec requires.
defineMissingMethods(Uint8Array.prototype, {
  toHex() {
    assertUint8Array(this, "toHex");
    assertBytesReadable(this);
    let encoded = "";
    for (let index = 0; index < this.length; index++) {
      encoded += HEX_PAIRS[this[index]];
    }
    return encoded;
  },
  toBase64(options = undefined) {
    assertUint8Array(this, "toBase64");
    const opts = readOptions(options);
    const alphabet = readAlphabet(opts);
    const omitPadding = Boolean(opts.omitPadding);
    // After the option reads: an option getter can detach the buffer.
    assertBytesReadable(this);
    return encodeBase64(this, alphabet === "base64url" ? BASE64URL_CHARS : BASE64_CHARS, omitPadding);
  },
});

defineMissingMethods(Uint8Array, {
  fromHex(string) {
    assertString(string, "fromHex");
    if (string.length % 2 !== 0) {
      throw new SyntaxError("Uint8Array.fromHex requires a string with an even length");
    }
    const output = new Uint8Array(string.length / 2);
    for (let index = 0; index < output.length; index++) {
      output[index] = (decodeHexDigit(string, index * 2) << 4) | decodeHexDigit(string, index * 2 + 1);
    }
    return output;
  },
  fromBase64(string, options = undefined) {
    assertString(string, "fromBase64");
    const opts = readOptions(options);
    const alphabet = readAlphabet(opts);
    const lastChunkHandling = readLastChunkHandling(opts);
    return decodeBase64(string, alphabet, lastChunkHandling);
  },
});
