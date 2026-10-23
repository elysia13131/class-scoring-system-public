"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  AgentLinkWechat: () => AgentLinkWechat,
  AuthError: () => AuthError,
  ILinkError: () => ILinkError,
  ILinkHttpClient: () => ILinkHttpClient,
  LoginCancelledError: () => LoginCancelledError,
  MediaError: () => MediaError,
  Message: () => Message,
  MessageItemType: () => MessageItemType,
  MessageState: () => MessageState,
  MessageType: () => MessageType,
  NetworkError: () => NetworkError,
  ProtocolError: () => ProtocolError,
  ReplyStream: () => ReplyStream,
  Store: () => Store,
  TypingIndicator: () => TypingIndicator,
  TypingStatus: () => TypingStatus,
  UploadMediaType: () => UploadMediaType,
  createFileMessageItem: () => createFileMessageItem,
  createImageMessageItem: () => createImageMessageItem,
  createMediaEncryptionMaterial: () => createMediaEncryptionMaterial,
  createMediaMessageItem: () => createMediaMessageItem,
  createVideoMessageItem: () => createVideoMessageItem,
  decryptAes128Ecb: () => decryptAes128Ecb,
  downloadMessageMedia: () => downloadMessageMedia,
  encryptAes128Ecb: () => encryptAes128Ecb,
  parseAesKey: () => parseAesKey,
  resolveDestination: () => resolveDestination,
  uploadMediaFile: () => uploadMediaFile
});
module.exports = __toCommonJS(index_exports);

// src/bot.ts
var import_node_events = require("events");

// src/constants.ts
var DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
var DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
var DEFAULT_CHANNEL_VERSION = "2.1.1";
var DEFAULT_CLIENT_VERSION = "131329";
var DEFAULT_TIMEOUTS = {
  get: 5e3,
  loginPoll: 35e3,
  updates: 35e3,
  typing: 1e4,
  defaultPost: 35e3
};
var STREAM_DEFAULTS = {
  minChunkSize: 200,
  flushInterval: 3e3,
  maxChunkSize: 4e3,
  showTyping: true
};

// src/errors.ts
var ILinkError = class extends Error {
  code;
  constructor(message, code, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
};
var AuthError = class extends ILinkError {
};
var LoginCancelledError = class extends AuthError {
};
var NetworkError = class extends ILinkError {
  isTimeout;
  constructor(message, code, options) {
    super(message, code, options);
    this.isTimeout = options?.isTimeout ?? false;
  }
};
var ProtocolError = class extends ILinkError {
};
var MediaError = class extends ILinkError {
};

// src/utils/ids.ts
var import_node_crypto = require("crypto");
var counter = 0;
function createClientId(botId) {
  counter += 1;
  const safeBotId = botId.replace(/[^a-z0-9]+/gi, "-");
  return `sdk-${safeBotId}-${Date.now()}-${counter}`;
}
function createWechatUin() {
  const value = Math.floor(Math.random() * 4294967296);
  return Buffer.from(String(value), "utf8").toString("base64");
}
function sanitizeAccountId(botId) {
  return botId.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

// src/http/client.ts
var ILinkHttpClient = class {
  fetchImpl;
  baseUrl;
  credentials;
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.credentials = options.credentials ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  setBaseUrl(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }
  setCredentials(credentials) {
    this.credentials = credentials;
    if (credentials) {
      this.setBaseUrl(credentials.baseUrl);
    }
  }
  async get(path, timeout = DEFAULT_TIMEOUTS.get) {
    return this.request("GET", path, void 0, timeout, false);
  }
  async post(path, body, timeout = DEFAULT_TIMEOUTS.defaultPost) {
    return this.request("POST", path, body, timeout, true);
  }
  async upload(url, body, headers = {}, method = "POST") {
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body
      });
    } catch (error) {
      throw new NetworkError("Failed to upload media", void 0, { cause: error });
    }
  }
  async download(url) {
    try {
      return await this.fetchImpl(url, { method: "GET" });
    } catch (error) {
      throw new NetworkError("Failed to download media", void 0, { cause: error });
    }
  }
  async request(method, path, body, timeout, withAuth) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const url = new URL(path.replace(/^\/+/, ""), `${this.baseUrl}/`);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: this.buildHeaders(withAuth),
        body: body ? JSON.stringify(body) : void 0,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new NetworkError(`HTTP ${response.status} for ${url.pathname}`);
      }
      const data = await response.json();
      const code = typeof data.ret === "number" && data.ret !== 0 ? data.ret : data.errcode;
      if (typeof code === "number" && code !== 0) {
        if (code === -14) {
          throw new AuthError("Session expired", code);
        }
        throw new ProtocolError(`iLink API returned error code ${code}`, code);
      }
      return data;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new NetworkError(`Request timed out after ${timeout}ms`, void 0, { cause: error, isTimeout: true });
      }
      if (error instanceof AuthError || error instanceof ProtocolError || error instanceof NetworkError) {
        throw error;
      }
      throw new NetworkError(`Request failed: ${url.pathname}`, void 0, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
  buildHeaders(withAuth) {
    const headers = {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": DEFAULT_CLIENT_VERSION
    };
    if (!withAuth) {
      return headers;
    }
    if (!this.credentials) {
      throw new AuthError("Missing credentials");
    }
    headers["Content-Type"] = "application/json";
    headers.AuthorizationType = "ilink_bot_token";
    headers.Authorization = `Bearer ${this.credentials.botToken}`;
    headers["X-WECHAT-UIN"] = createWechatUin();
    if (typeof this.credentials.routeTag === "number") {
      headers.SKRouteTag = String(this.credentials.routeTag);
    }
    return headers;
  }
};

// src/auth/qrcode.ts
var QrCodeLogin = class {
  http;
  maxRefreshes;
  onScanned;
  onQrcode;
  constructor(http, options = {}) {
    this.http = http ?? new ILinkHttpClient({ baseUrl: DEFAULT_BASE_URL });
    this.maxRefreshes = options.maxRefreshes ?? 3;
    this.onScanned = options.onScanned;
    this.onQrcode = options.onQrcode;
  }
  async createLogin(signal) {
    this.throwIfCancelled(signal);
    const response = await this.http.get("ilink/bot/get_bot_qrcode?bot_type=3");
    this.throwIfCancelled(signal);
    const result = {
      qrcodeId: response.qrcode,
      qrcodeUrl: response.qrcode_img_content
    };
    this.onQrcode?.(result.qrcodeUrl);
    return result;
  }
  async waitForLogin(loginResult, signal) {
    this.throwIfCancelled(signal);
    let current = loginResult ?? await this.createLogin(signal);
    let refreshCount = 0;
    while (refreshCount <= this.maxRefreshes) {
      this.throwIfCancelled(signal);
      const credentials = await this.pollUntilResolved(current.qrcodeId, signal);
      if (credentials) {
        return credentials;
      }
      refreshCount += 1;
      if (refreshCount > this.maxRefreshes) {
        break;
      }
      current = await this.createLogin(signal);
    }
    throw new AuthError("QR code expired too many times");
  }
  async pollUntilResolved(qrcodeId, signal) {
    for (; ; ) {
      this.throwIfCancelled(signal);
      const response = await this.http.get(
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`,
        DEFAULT_TIMEOUTS.loginPoll
      );
      this.throwIfCancelled(signal);
      switch (response.status) {
        case "wait":
          continue;
        case "scaned":
          this.onScanned?.();
          continue;
        case "scaned_but_redirect":
          if (response.redirect_host) {
            this.http.setBaseUrl(`https://${response.redirect_host}`);
          }
          continue;
        case "expired":
          return null;
        case "confirmed":
          return this.toCredentials(response);
        default:
          throw new AuthError(`Unexpected QR code status: ${String(response.status)}`);
      }
    }
  }
  toCredentials(response) {
    if (!response.bot_token || !response.ilink_bot_id || !response.ilink_user_id || !response.baseurl) {
      throw new AuthError("Confirmed response missing credentials");
    }
    return {
      botToken: response.bot_token,
      botId: response.ilink_bot_id,
      userId: response.ilink_user_id,
      baseUrl: response.baseurl,
      routeTag: response.route_tag,
      savedAt: Date.now()
    };
  }
  throwIfCancelled(signal) {
    if (signal?.aborted) {
      throw new LoginCancelledError("Login cancelled");
    }
  }
};

// src/auth/session.ts
var SessionState = class {
  credentials;
  pausedUntil = 0;
  constructor(credentials = null) {
    this.credentials = credentials;
  }
  setCredentials(credentials) {
    this.credentials = credentials;
  }
  getCredentials() {
    return this.credentials;
  }
  get accountId() {
    return this.credentials?.botId ?? null;
  }
  assertActive() {
    if (!this.credentials) {
      throw new AuthError("Not logged in");
    }
    if (this.pausedUntil > Date.now()) {
      throw new AuthError("Session is paused due to prior logout");
    }
    return this.credentials;
  }
  pauseFor(durationMs) {
    this.pausedUntil = Date.now() + durationMs;
  }
  clearPause() {
    this.pausedUntil = 0;
  }
};

// src/media/download.ts
var import_promises = require("fs/promises");
var import_node_path = require("path");

// src/media/crypto.ts
var import_node_crypto2 = require("crypto");
function parseAesKey(raw) {
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  const hex = decoded.toString("ascii");
  if (/^[0-9a-f]{32}$/i.test(hex)) {
    return Buffer.from(hex, "hex");
  }
  throw new MediaError("Unknown AES key format");
}
function encryptAes128Ecb(data, key) {
  const cipher = (0, import_node_crypto2.createCipheriv)("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
function decryptAes128Ecb(data, key) {
  const decipher = (0, import_node_crypto2.createDecipheriv)("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
function createMediaEncryptionMaterial() {
  const aesKey = (0, import_node_crypto2.randomBytes)(16);
  return {
    fileKeyHex: (0, import_node_crypto2.randomBytes)(16).toString("hex"),
    aesKeyHex: aesKey.toString("hex"),
    aesKey
  };
}

// src/types/api.ts
var MessageType = /* @__PURE__ */ ((MessageType2) => {
  MessageType2[MessageType2["NONE"] = 0] = "NONE";
  MessageType2[MessageType2["USER"] = 1] = "USER";
  MessageType2[MessageType2["BOT"] = 2] = "BOT";
  return MessageType2;
})(MessageType || {});
var MessageItemType = /* @__PURE__ */ ((MessageItemType2) => {
  MessageItemType2[MessageItemType2["NONE"] = 0] = "NONE";
  MessageItemType2[MessageItemType2["TEXT"] = 1] = "TEXT";
  MessageItemType2[MessageItemType2["IMAGE"] = 2] = "IMAGE";
  MessageItemType2[MessageItemType2["VOICE"] = 3] = "VOICE";
  MessageItemType2[MessageItemType2["FILE"] = 4] = "FILE";
  MessageItemType2[MessageItemType2["VIDEO"] = 5] = "VIDEO";
  return MessageItemType2;
})(MessageItemType || {});
var MessageState = /* @__PURE__ */ ((MessageState2) => {
  MessageState2[MessageState2["NEW"] = 0] = "NEW";
  MessageState2[MessageState2["GENERATING"] = 1] = "GENERATING";
  MessageState2[MessageState2["FINISH"] = 2] = "FINISH";
  return MessageState2;
})(MessageState || {});
var TypingStatus = /* @__PURE__ */ ((TypingStatus2) => {
  TypingStatus2[TypingStatus2["TYPING"] = 1] = "TYPING";
  TypingStatus2[TypingStatus2["CANCEL"] = 2] = "CANCEL";
  return TypingStatus2;
})(TypingStatus || {});
var UploadMediaType = /* @__PURE__ */ ((UploadMediaType2) => {
  UploadMediaType2[UploadMediaType2["IMAGE"] = 1] = "IMAGE";
  UploadMediaType2[UploadMediaType2["VIDEO"] = 2] = "VIDEO";
  UploadMediaType2[UploadMediaType2["FILE"] = 3] = "FILE";
  UploadMediaType2[UploadMediaType2["VOICE"] = 4] = "VOICE";
  return UploadMediaType2;
})(UploadMediaType || {});

// src/media/download.ts
async function downloadMessageMedia(params) {
  const { http, item, destination, cdnBaseUrl = DEFAULT_CDN_BASE_URL, rootDir } = params;
  const media = extractMedia(item);
  if (!media) {
    throw new MediaError("Message does not contain downloadable media");
  }
  const finalDestination = rootDir ? resolveDestination(rootDir, destination) : destination;
  const response = await http.download(buildDownloadUrl(media.url, media.queryParam, cdnBaseUrl));
  if (!response.ok) {
    throw new MediaError(`Media download failed with status ${response.status}`);
  }
  const encrypted = Buffer.from(await response.arrayBuffer());
  const buffer = media.aesKey ? decryptAes128Ecb(encrypted, media.aesKey) : encrypted;
  await (0, import_promises.mkdir)((0, import_node_path.dirname)(finalDestination), { recursive: true });
  await (0, import_promises.writeFile)(finalDestination, buffer);
  return finalDestination;
}
function resolveDestination(rootDir, destination) {
  const resolvedRoot = (0, import_node_path.resolve)(rootDir);
  const resolvedDestination = (0, import_node_path.resolve)(rootDir, destination);
  if (resolvedDestination !== resolvedRoot && !resolvedDestination.startsWith(`${resolvedRoot}${import_node_path.sep}`)) {
    throw new MediaError("Destination escapes the configured data directory");
  }
  return resolvedDestination;
}
function extractMedia(item) {
  switch (item.type) {
    case 2 /* IMAGE */:
      return fromImage(item);
    case 4 /* FILE */:
      return fromDescriptor(item.file_item?.media, item.file_item?.media?.aes_key);
    case 5 /* VIDEO */:
      return fromDescriptor(item.video_item?.media, item.video_item?.media?.aes_key);
    case 3 /* VOICE */:
      return fromDescriptor(item.voice_item?.media, item.voice_item?.media?.aes_key);
    default:
      return null;
  }
}
function fromImage(item) {
  const descriptor = item.image_item?.media;
  if (!descriptor) {
    return null;
  }
  const queryParam = descriptor.encrypt_query_param ?? descriptor.encrypted_query_param;
  if (item.image_item?.aeskey) {
    return {
      url: descriptor.full_url,
      queryParam,
      aesKey: Buffer.from(item.image_item.aeskey, "hex")
    };
  }
  return fromDescriptor(descriptor, descriptor.aes_key);
}
function fromDescriptor(descriptor, aesKeyBase64) {
  if (!descriptor) {
    return null;
  }
  return {
    url: descriptor.full_url,
    queryParam: descriptor.encrypt_query_param ?? descriptor.encrypted_query_param,
    aesKey: aesKeyBase64 ? parseAesKey(aesKeyBase64) : void 0
  };
}
function buildDownloadUrl(fullUrl, queryParam, cdnBaseUrl) {
  if (fullUrl) {
    return fullUrl;
  }
  if (!queryParam) {
    throw new MediaError("Missing media download URL");
  }
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(queryParam)}`;
}

// src/media/upload.ts
var import_node_crypto3 = require("crypto");
var import_node_path3 = require("path");
var import_promises2 = require("fs/promises");

// src/utils/mime.ts
var import_node_path2 = require("path");
var IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
var VIDEO_EXTENSIONS = /* @__PURE__ */ new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
function getUploadMediaType(filePath) {
  const extension = (0, import_node_path2.extname)(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 1 /* IMAGE */;
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return 2 /* VIDEO */;
  }
  return 3 /* FILE */;
}
function getContentType(filePath) {
  const extension = (0, import_node_path2.extname)(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".mp4":
      return "video/mp4";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

// src/media/upload.ts
async function uploadMediaFile(params) {
  const { http, filePath, toUserId, channelVersion, cdnBaseUrl = DEFAULT_CDN_BASE_URL } = params;
  const plaintext = await (0, import_promises2.readFile)(filePath);
  const { fileKeyHex, aesKeyHex, aesKey } = createMediaEncryptionMaterial();
  const rawfilemd5 = (0, import_node_crypto3.createHash)("md5").update(plaintext).digest("hex");
  const ciphertext = encryptAes128Ecb(plaintext, aesKey);
  const mediaType = getUploadMediaType(filePath);
  const response = await http.post("ilink/bot/getuploadurl", {
    filekey: fileKeyHex,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: plaintext.length,
    rawfilemd5,
    filesize: ciphertext.length,
    no_need_thumb: true,
    aeskey: aesKeyHex,
    base_info: { channel_version: channelVersion }
  });
  const uploadUrl = buildUploadUrl(response, cdnBaseUrl, fileKeyHex);
  const uploaded = await uploadCiphertext(http, uploadUrl, ciphertext, getContentType(filePath));
  return {
    downloadEncryptedQueryParam: uploaded,
    aesKeyHex,
    aesKeyBase64: Buffer.from(aesKeyHex, "utf8").toString("base64"),
    fileKeyHex,
    fileSize: plaintext.length,
    ciphertextSize: ciphertext.length,
    mediaType,
    fileName: (0, import_node_path3.basename)(filePath)
  };
}
function createImageMessageItem(uploaded) {
  return {
    type: 2 /* IMAGE */,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploaded.aesKeyBase64,
        encrypt_type: 1
      },
      aeskey: uploaded.aesKeyHex,
      mid_size: uploaded.ciphertextSize
    }
  };
}
function createFileMessageItem(uploaded) {
  return {
    type: 4 /* FILE */,
    file_item: {
      file_name: uploaded.fileName,
      len: String(uploaded.fileSize),
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploaded.aesKeyBase64,
        encrypt_type: 1
      }
    }
  };
}
function createVideoMessageItem(uploaded) {
  return {
    type: 5 /* VIDEO */,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploaded.aesKeyBase64,
        encrypt_type: 1
      },
      video_size: uploaded.ciphertextSize
    }
  };
}
function createMediaMessageItem(uploaded) {
  if (uploaded.mediaType == 1 /* IMAGE */) {
    return createImageMessageItem(uploaded);
  }
  if (uploaded.mediaType == 2 /* VIDEO */) {
    return createVideoMessageItem(uploaded);
  }
  return createFileMessageItem(uploaded);
}
function buildUploadUrl(response, cdnBaseUrl, fileKeyHex) {
  if (response.upload_full_url?.trim()) {
    return response.upload_full_url.trim();
  }
  if (response.upload_param) {
    return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(response.upload_param)}&filekey=${encodeURIComponent(fileKeyHex)}`;
  }
  throw new MediaError("Upload URL missing from getuploadurl response");
}
async function uploadCiphertext(http, uploadUrl, ciphertext, contentType) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await http.upload(uploadUrl, ciphertext, { "Content-Type": contentType }, "POST");
    if (response.status >= 400 && response.status < 500) {
      throw new MediaError(`CDN upload failed with client error ${response.status}`);
    }
    if (response.status !== 200) {
      lastError = new MediaError(`CDN upload failed with server error ${response.status}`);
      if (attempt < 3) {
        continue;
      }
      throw lastError;
    }
    const downloadParam = response.headers.get("x-encrypted-param");
    if (!downloadParam) {
      throw new MediaError("CDN upload response missing x-encrypted-param");
    }
    return downloadParam;
  }
  throw lastError instanceof Error ? lastError : new MediaError("CDN upload failed");
}

// src/messaging/receiver.ts
var Message = class {
  constructor(runtime, raw) {
    this.runtime = runtime;
    this.raw = raw;
    this.id = BigInt(raw.message_id);
    this.userId = raw.from_user_id;
    this.userName = raw.from_user_id;
    this.timestamp = new Date(raw.create_time_ms);
    this.text = extractText(raw.item_list);
    this.items = raw.item_list;
    this.contextToken = raw.context_token;
  }
  id;
  userId;
  userName;
  timestamp;
  text;
  items;
  contextToken;
  get hasMedia() {
    return this.mediaType !== null;
  }
  get mediaType() {
    for (const item of this.items) {
      switch (item.type) {
        case 2 /* IMAGE */:
          return "image";
        case 3 /* VOICE */:
          return "voice";
        case 4 /* FILE */:
          return "file";
        case 5 /* VIDEO */:
          return "video";
      }
    }
    return null;
  }
  async reply(text) {
    await this.runtime.saveContextToken(this.userId, this.contextToken);
    await this.runtime.sender.replyText(this.userId, this.contextToken, text);
  }
  async replyImage(filePath) {
    await this.runtime.replyImage(this, filePath);
  }
  async replyFile(filePath) {
    await this.runtime.replyFile(this, filePath);
  }
  createReplyStream(options) {
    return this.runtime.createReplyStream(this, options);
  }
  /**
   * Downloads the first media item in the message into the bot's configured
   * `dataDir`.
   *
   * `destination` is treated as an application-provided path relative to
   * `dataDir`. For example, `downloads/image.jpg` is saved to
   * `<dataDir>/downloads/image.jpg`. Paths that escape `dataDir` are rejected.
   *
   * Returns the final resolved file path.
   */
  async downloadMedia(destination) {
    if (!this.runtime.downloadMedia) {
      throw new Error("downloadMedia is available in Phase 3");
    }
    return this.runtime.downloadMedia(this, destination);
  }
};
function extractText(items) {
  const chunks = [];
  for (const item of items) {
    if (item.ref_msg_item && (item.ref_msg_item.title || item.ref_msg_item.ref_body)) {
      chunks.push(`[\u5F15\u7528: ${item.ref_msg_item.title ?? ""} | ${item.ref_msg_item.ref_body ?? ""}]`);
    }
    if (item.type === 1 /* TEXT */ && item.text_item?.text) {
      chunks.push(item.text_item.text);
    }
    if (item.type === 3 /* VOICE */ && item.voice_item?.text) {
      chunks.push(item.voice_item.text);
    }
  }
  return chunks.join("\n").trim();
}
function createMessage(runtime, raw) {
  return new Message(runtime, raw);
}

// src/utils/markdown.ts
function markdownToPlainText(input) {
  return input.replace(/```([\s\S]*?)```/g, "$1").replace(/!\[[^\]]*\]\([^)]+\)/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^\|?[\s:-]+\|?$/gm, "").replace(/\|/g, " ").trim();
}

// src/messaging/sender.ts
function splitText(text, maxChunkSize) {
  if (text.length <= maxChunkSize) {
    return [text];
  }
  const chunks = [];
  for (let index = 0; index < text.length; index += maxChunkSize) {
    chunks.push(text.slice(index, index + maxChunkSize));
  }
  return chunks;
}
function buildTextItems(text, maxChunkSize = 4e3) {
  return splitText(text, maxChunkSize).map((chunk) => ({
    type: 1 /* TEXT */,
    text_item: { text: chunk }
  }));
}
function buildSendPayload(params) {
  return {
    msg: {
      from_user_id: "",
      to_user_id: params.toUserId,
      client_id: params.clientId,
      message_type: 2 /* BOT */,
      message_state: params.state,
      item_list: params.items,
      context_token: params.contextToken
    },
    base_info: {
      channel_version: params.channelVersion
    }
  };
}
var MessageSender = class {
  constructor(http, getCredentials, getChannelVersion) {
    this.http = http;
    this.getCredentials = getCredentials;
    this.getChannelVersion = getChannelVersion;
  }
  async sendText(params) {
    const preparedText = params.normalizeMarkdown === false ? params.text : markdownToPlainText(params.text);
    await this.sendItems(params.toUserId, params.contextToken, buildTextItems(preparedText), params.state ?? 2 /* FINISH */, params.clientId);
  }
  async sendItems(toUserId, contextToken, items, state = 2 /* FINISH */, clientId) {
    const credentials = this.getCredentials();
    const payload = buildSendPayload({
      toUserId,
      clientId: clientId ?? createClientId(credentials.botId),
      contextToken,
      items,
      state,
      channelVersion: this.getChannelVersion()
    });
    const response = await this.http.post("ilink/bot/sendmessage", payload);
    if (typeof response.ret === "number" && response.ret !== 0) {
      throw new ProtocolError(`Failed to send message with ret=${response.ret}`, response.ret);
    }
  }
  async replyText(toUserId, contextToken, text, state = 2 /* FINISH */, clientId) {
    const credentials = this.getCredentials();
    await this.sendText({
      credentials,
      toUserId,
      contextToken,
      text,
      state,
      clientId
    });
  }
};

// src/messaging/stream.ts
var ReplyStream = class {
  sender;
  typing;
  message;
  options;
  clientId;
  buffer = "";
  transcript = "";
  lastSnapshot = "";
  flushTimer = null;
  inflight = Promise.resolve();
  closed = false;
  sentAny = false;
  queuedAny = false;
  typingStarted = false;
  constructor(sender, typing, message, botId, options = {}) {
    this.sender = sender;
    this.typing = typing;
    this.message = message;
    this.clientId = createClientId(botId);
    this.options = {
      minChunkSize: options.minChunkSize ?? STREAM_DEFAULTS.minChunkSize,
      flushInterval: options.flushInterval ?? STREAM_DEFAULTS.flushInterval,
      maxChunkSize: options.maxChunkSize ?? STREAM_DEFAULTS.maxChunkSize,
      showTyping: options.showTyping ?? STREAM_DEFAULTS.showTyping
    };
  }
  write(chunk) {
    if (this.closed || chunk.length === 0) {
      return;
    }
    if (this.options.showTyping && this.typing && !this.typingStarted) {
      this.typingStarted = true;
      this.inflight = this.inflight.then(() => this.typing?.start(this.message.userId, this.message.contextToken));
    }
    const normalized = markdownToPlainText(chunk);
    this.buffer += normalized;
    this.transcript += normalized;
    if (this.buffer.length >= this.options.minChunkSize) {
      this.queueFlush(1 /* GENERATING */);
      return;
    }
    this.armTimer();
  }
  async end() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearTimer();
    if (this.transcript.length > 0) {
      this.queueFlush(2 /* FINISH */, true);
    } else if (this.sentAny || this.queuedAny) {
      this.queueSend("", 2 /* FINISH */);
    }
    await this.inflight.finally(async () => {
      await this.stopTyping();
    });
  }
  abort() {
    this.closed = true;
    this.buffer = "";
    this.clearTimer();
    void this.stopTyping();
  }
  armTimer() {
    this.clearTimer();
    this.flushTimer = setTimeout(() => {
      this.queueFlush(1 /* GENERATING */);
    }, this.options.flushInterval);
  }
  clearTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
  queueFlush(state, forceFinish = false) {
    this.clearTimer();
    this.buffer = "";
    const snapshot = this.transcript;
    if (!forceFinish && snapshot.length === 0) {
      return;
    }
    if (!forceFinish && snapshot === this.lastSnapshot) {
      return;
    }
    this.queueSend(snapshot, forceFinish ? 2 /* FINISH */ : state);
  }
  queueSend(text, state) {
    this.queuedAny = true;
    this.lastSnapshot = text;
    this.inflight = this.inflight.then(async () => {
      await this.sender.replyText(this.message.userId, this.message.contextToken, text, state, this.clientId);
      this.sentAny = true;
    });
  }
  async stopTyping() {
    if (!this.typingStarted || !this.typing) {
      return;
    }
    this.typingStarted = false;
    await this.typing.stop(this.message.userId);
  }
};

// src/messaging/typing.ts
var import_node_crypto4 = require("crypto");
var TypingIndicator = class {
  constructor(http, getCredentials, getChannelVersion) {
    this.http = http;
    this.getCredentials = getCredentials;
    this.getChannelVersion = getChannelVersion;
  }
  tickets = /* @__PURE__ */ new Map();
  intervals = /* @__PURE__ */ new Map();
  async start(userId, contextToken) {
    this.getCredentials();
    const ticket = await this.ensureTicket(userId, contextToken);
    await this.send(userId, ticket.ticket, 1 /* TYPING */);
    if (this.intervals.has(userId)) {
      return;
    }
    const interval = setInterval(() => {
      const current = this.tickets.get(userId);
      if (!current) {
        return;
      }
      void this.send(userId, current.ticket, 1 /* TYPING */);
    }, 5e3);
    this.intervals.set(userId, interval);
  }
  async stop(userId) {
    const interval = this.intervals.get(userId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(userId);
    }
    const ticket = this.tickets.get(userId);
    if (ticket) {
      await this.send(userId, ticket.ticket, 2 /* CANCEL */);
    }
  }
  async ensureTicket(userId, contextToken) {
    const current = this.tickets.get(userId);
    if (current && Date.now() < current.expiresAt) {
      return current;
    }
    const response = await this.http.post("ilink/bot/getconfig", {
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: { channel_version: this.getChannelVersion() }
    });
    const ticket = {
      ticket: response.typing_ticket ?? "",
      expiresAt: Date.now() + (0, import_node_crypto4.randomInt)(12, 24) * 36e5
    };
    this.tickets.set(userId, ticket);
    return ticket;
  }
  async send(userId, ticket, status) {
    if (!ticket) {
      return;
    }
    await this.http.post("ilink/bot/sendtyping", {
      ilink_user_id: userId,
      typing_ticket: ticket,
      status,
      base_info: { channel_version: this.getChannelVersion() }
    });
  }
};

// src/polling/updater.ts
var UpdatesPoller = class {
  constructor(http, options) {
    this.http = http;
    this.options = options;
  }
  aborted = false;
  failCount = 0;
  running = null;
  start() {
    if (!this.running) {
      this.aborted = false;
      this.running = this.pollLoop().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }
  stop() {
    this.aborted = true;
  }
  async pollLoop() {
    let timeoutMs = DEFAULT_TIMEOUTS.updates;
    while (!this.aborted) {
      try {
        const response = await this.http.post("ilink/bot/getupdates", {
          get_updates_buf: await this.options.getCursor(),
          base_info: { channel_version: this.options.getChannelVersion() }
        }, timeoutMs);
        if (typeof response.longpolling_timeout_ms === "number" && response.longpolling_timeout_ms > 0) {
          timeoutMs = response.longpolling_timeout_ms;
        }
        if (response.get_updates_buf !== void 0) {
          await this.options.saveCursor(response.get_updates_buf);
        }
        for (const message of response.msgs ?? []) {
          await this.options.onMessage(message);
        }
        this.failCount = 0;
      } catch (error) {
        if (error instanceof AuthError && error.code === -14) {
          this.aborted = true;
          await this.options.onLogout("session_expired");
          return;
        }
        if (error instanceof NetworkError && error.isTimeout) {
          this.failCount = 0;
          continue;
        }
        this.failCount += 1;
        this.options.onError(error);
        const delay = this.failCount >= 3 ? 3e4 : 2e3;
        if (this.failCount >= 3) {
          this.failCount = 0;
        }
        await this.sleep(delay);
      }
    }
  }
  async sleep(ms) {
    if (this.aborted) {
      return;
    }
    if (this.options.sleep) {
      await this.options.sleep(ms);
      return;
    }
    await new Promise((resolve2) => {
      setTimeout(resolve2, ms);
    });
  }
};

// src/storage/store.ts
var import_promises3 = require("fs/promises");
var import_node_path4 = require("path");
var Store = class {
  rootDir;
  channelDir;
  accountsDir;
  credentialsDir;
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.channelDir = (0, import_node_path4.join)(rootDir, "wechat");
    this.accountsDir = (0, import_node_path4.join)(this.channelDir, "accounts");
    this.credentialsDir = (0, import_node_path4.join)(rootDir, "credentials");
  }
  async ensure() {
    await (0, import_promises3.mkdir)(this.accountsDir, { recursive: true });
    await (0, import_promises3.mkdir)(this.credentialsDir, { recursive: true });
  }
  async saveCredentials(credentials) {
    await this.ensure();
    const accountId = sanitizeAccountId(credentials.botId);
    const previousAccountId = await this.findAccountIdByUserId(credentials.userId);
    if (previousAccountId && previousAccountId !== accountId) {
      await this.clearAccount(previousAccountId);
    }
    await this.writeJson(this.accountPath(accountId), credentials);
    await this.updateAccountsIndex(accountId, true);
  }
  async loadCredentials(accountId) {
    await this.ensure();
    if (accountId) {
      return this.readJson(this.accountPath(accountId), null);
    }
    const ids = await this.listAccounts();
    if (ids.length === 0) {
      return null;
    }
    return this.readJson(this.accountPath(ids[0]), null);
  }
  async loadAllCredentials() {
    const ids = await this.listAccounts();
    const credentials = await Promise.all(ids.map((accountId) => this.readJson(this.accountPath(accountId), null)));
    return credentials.filter((value) => Boolean(value));
  }
  async clearCredentials(accountId) {
    await this.ensure();
    if (!accountId) {
      const ids = await this.listAccounts();
      await Promise.all(ids.map((id) => this.clearAccount(id)));
      await this.writeJson(this.accountsIndexPath(), { accounts: [] });
      return;
    }
    await this.clearAccount(accountId);
  }
  async saveCursor(accountId, cursor) {
    await this.writeJson(this.cursorPath(accountId), { get_updates_buf: cursor });
  }
  async loadCursor(accountId) {
    const file = await this.readJson(this.cursorPath(accountId), { get_updates_buf: "" });
    return file.get_updates_buf ?? "";
  }
  async saveContextToken(accountId, userId, token) {
    const file = await this.readJson(this.contextTokensPath(accountId), { version: 1, tokens: {} });
    file.tokens[userId] = token;
    await this.writeJson(this.contextTokensPath(accountId), file);
  }
  async getContextToken(accountId, userId) {
    const file = await this.readJson(this.contextTokensPath(accountId), { version: 1, tokens: {} });
    return file.tokens[userId] ?? null;
  }
  async getAllContextTokens(accountId) {
    const file = await this.readJson(this.contextTokensPath(accountId), { version: 1, tokens: {} });
    return { ...file.tokens };
  }
  async setDebugMode(accountId, enabled) {
    const file = await this.readJson(this.debugModePath(), { accounts: {} });
    file.accounts[accountId] = enabled;
    await this.writeJson(this.debugModePath(), file);
  }
  async getDebugMode(accountId) {
    const file = await this.readJson(this.debugModePath(), { accounts: {} });
    return Boolean(file.accounts[accountId]);
  }
  async addAllowFrom(accountId, userId) {
    const file = await this.readJson(this.allowFromPath(accountId), { version: 1, allowFrom: [] });
    if (!file.allowFrom.includes(userId)) {
      file.allowFrom.push(userId);
      await this.writeJson(this.allowFromPath(accountId), file);
    }
  }
  async getAllowFrom(accountId) {
    const file = await this.readJson(this.allowFromPath(accountId), { version: 1, allowFrom: [] });
    return [...file.allowFrom];
  }
  async listAccounts() {
    const index = await this.readJson(this.accountsIndexPath(), { accounts: [] });
    return [...new Set(index.accounts)];
  }
  async updateAccountsIndex(accountId, add) {
    const index = await this.readJson(this.accountsIndexPath(), { accounts: [] });
    const next = add ? [.../* @__PURE__ */ new Set([...index.accounts, accountId])] : index.accounts.filter((entry) => entry !== accountId);
    await this.writeJson(this.accountsIndexPath(), { accounts: next });
  }
  async findAccountIdByUserId(userId) {
    const accounts = await this.loadAllCredentials();
    const matched = accounts.find((entry) => entry.userId === userId);
    return matched ? sanitizeAccountId(matched.botId) : null;
  }
  async clearAccount(accountId) {
    await (0, import_promises3.rm)(this.accountPath(accountId), { force: true });
    await (0, import_promises3.rm)(this.cursorPath(accountId), { force: true });
    await (0, import_promises3.rm)(this.contextTokensPath(accountId), { force: true });
    await (0, import_promises3.rm)(this.allowFromPath(accountId), { force: true });
    await this.updateAccountsIndex(accountId, false);
  }
  accountPath(accountId) {
    return (0, import_node_path4.join)(this.accountsDir, `${accountId}.json`);
  }
  cursorPath(accountId) {
    return (0, import_node_path4.join)(this.accountsDir, `${accountId}.sync.json`);
  }
  contextTokensPath(accountId) {
    return (0, import_node_path4.join)(this.accountsDir, `${accountId}.context-tokens.json`);
  }
  debugModePath() {
    return (0, import_node_path4.join)(this.channelDir, "debug-mode.json");
  }
  allowFromPath(accountId) {
    return (0, import_node_path4.join)(this.credentialsDir, `agentlink-wechat-${accountId}-allowFrom.json`);
  }
  accountsIndexPath() {
    return (0, import_node_path4.join)(this.channelDir, "accounts.json");
  }
  async readJson(path, fallback) {
    try {
      const content = await (0, import_promises3.readFile)(path, "utf8");
      return JSON.parse(content);
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT") {
        return fallback;
      }
      throw error;
    }
  }
  async writeJson(path, value) {
    await (0, import_promises3.mkdir)((0, import_node_path4.dirname)(path), { recursive: true });
    await (0, import_promises3.writeFile)(path, `${JSON.stringify(value, null, 2)}
`, "utf8");
    try {
      await (0, import_promises3.chmod)(path, 384);
    } catch {
    }
  }
};

// src/utils/deferred.ts
function createDeferred() {
  let resolve2;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve2 = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve: resolve2, reject };
}

// src/utils/logger.ts
var import_promises4 = require("fs/promises");
var import_node_path6 = require("path");

// src/utils/paths.ts
var import_node_os = require("os");
var import_node_path5 = require("path");
function resolveDataDir(dataDir) {
  return dataDir ?? (0, import_node_path5.join)((0, import_node_os.homedir)(), ".agentlink", "wechat");
}
function resolveLogPath(date = /* @__PURE__ */ new Date()) {
  const day = date.toISOString().slice(0, 10);
  return (0, import_node_path5.join)((0, import_node_os.tmpdir)(), `agentlink-wechat-${day}.log`);
}

// src/utils/logger.ts
var LEVELS = {
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5
};
var SECRET_KEY_PATTERN = /(token|context|aes|authorization|ticket|secret|key)/i;
function normalizeLevel(level) {
  if (!level) {
    return "info";
  }
  const normalized = level.toLowerCase();
  return normalized in LEVELS ? normalized : "info";
}
function redactSecretString(value) {
  return `${value.slice(0, 6)}...(${value.length})`;
}
function redact(value, keyHint) {
  if (typeof value === "string") {
    if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) {
      return redactSecretString(value);
    }
    if (/^[a-z0-9]+@im\.bot:/i.test(value)) {
      return redactSecretString(value);
    }
    if (value.startsWith("http://") || value.startsWith("https://")) {
      try {
        const url = new URL(value);
        url.search = "";
        return url.toString();
      } catch {
        return value;
      }
    }
    return value.length > 200 ? `${value.slice(0, 200)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, keyHint));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, redact(inner, key)])
    );
  }
  return value;
}
function sanitizeLogMeta(meta) {
  return redact(meta);
}
var Logger = class {
  threshold;
  logPath;
  constructor(level) {
    const resolvedLevel = normalizeLevel(process.env.OPENCLAW_LOG_LEVEL ?? level);
    this.threshold = LEVELS[resolvedLevel];
    this.logPath = resolveLogPath();
  }
  trace(message, meta) {
    this.log("trace", message, meta);
  }
  debug(message, meta) {
    this.log("debug", message, meta);
  }
  info(message, meta) {
    this.log("info", message, meta);
  }
  warn(message, meta) {
    this.log("warn", message, meta);
  }
  error(message, meta) {
    this.log("error", message, meta);
  }
  log(level, message, meta) {
    if (LEVELS[level] < this.threshold) {
      return;
    }
    const entry = JSON.stringify({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level: level.toUpperCase(),
      message,
      meta: meta === void 0 ? void 0 : sanitizeLogMeta(meta)
    });
    void this.write(entry);
  }
  async write(line) {
    await (0, import_promises4.mkdir)((0, import_node_path6.dirname)(this.logPath), { recursive: true });
    await (0, import_promises4.appendFile)(this.logPath, `${line}
`, "utf8");
  }
};

// src/utils/task-queue.ts
var TaskQueue = class {
  limit;
  activeCount = 0;
  pending = [];
  idleResolvers = [];
  constructor(limit = 1) {
    this.limit = Math.max(1, limit);
  }
  add(task) {
    return new Promise((resolve2, reject) => {
      const run = () => {
        this.activeCount += 1;
        Promise.resolve().then(task).then(resolve2, reject).finally(() => {
          this.activeCount -= 1;
          this.drain();
        });
      };
      if (this.activeCount < this.limit) {
        run();
        return;
      }
      this.pending.push(run);
    });
  }
  async onIdle() {
    if (this.activeCount === 0 && this.pending.length === 0) {
      return;
    }
    await new Promise((resolve2) => {
      this.idleResolvers.push(resolve2);
    });
  }
  drain() {
    while (this.activeCount < this.limit && this.pending.length > 0) {
      const next = this.pending.shift();
      next?.();
    }
    if (this.activeCount === 0 && this.pending.length === 0) {
      const resolvers = this.idleResolvers.splice(0, this.idleResolvers.length);
      for (const resolve2 of resolvers) {
        resolve2();
      }
    }
  }
};

// src/bot.ts
var AgentLinkWechat = class extends import_node_events.EventEmitter {
  store;
  http;
  session;
  sender;
  loginFlow;
  typing;
  logger;
  channelVersion;
  messageQueue;
  dataDir;
  selectedAccountId;
  dmPolicy;
  initialAllowFrom;
  poller = null;
  pendingLogin = createDeferred();
  lastLoginResult = null;
  restarting = false;
  loginAbortController = null;
  constructor(options = {}) {
    super();
    this.channelVersion = options.channelVersion ?? options.credentials?.channelVersion ?? DEFAULT_CHANNEL_VERSION;
    this.dataDir = resolveDataDir(options.dataDir);
    this.store = new Store(this.dataDir);
    this.session = new SessionState(options.credentials ?? null);
    this.http = new ILinkHttpClient({
      credentials: options.credentials ?? null,
      baseUrl: options.credentials?.baseUrl
    });
    this.logger = new Logger(options.logLevel);
    this.sender = new MessageSender(
      this.http,
      () => this.session.assertActive(),
      () => this.channelVersion
    );
    this.typing = new TypingIndicator(
      this.http,
      () => this.session.assertActive(),
      () => this.channelVersion
    );
    this.messageQueue = new TaskQueue(options.maxConcurrentMessages ?? 4);
    this.selectedAccountId = options.accountId ? sanitizeAccountId(options.accountId) : null;
    this.dmPolicy = options.dmPolicy ?? "pairing";
    this.initialAllowFrom = options.allowFrom ?? [];
    this.loginFlow = new QrCodeLogin(this.http, {
      onQrcode: (url) => this.emit("qrcode", url),
      onScanned: () => this.emit("qrcode:scanned")
    });
  }
  get isLoggedIn() {
    return this.session.getCredentials() !== null;
  }
  get botId() {
    return this.session.accountId;
  }
  async login() {
    this.cancelLogin();
    this.loginAbortController = new AbortController();
    this.pendingLogin = createDeferred();
    const result = await this.loginFlow.createLogin(this.loginAbortController.signal);
    this.lastLoginResult = result;
    this.logger.info("QR code created", { qrcodeId: result.qrcodeId });
    return result;
  }
  async waitForLogin() {
    if (!this.loginAbortController) {
      this.loginAbortController = new AbortController();
    }
    try {
      const credentials = await this.loginFlow.waitForLogin(this.lastLoginResult ?? void 0, this.loginAbortController.signal);
      await this.applyCredentials(credentials);
      this.pendingLogin.resolve(credentials);
      this.pendingLogin = createDeferred();
      this.emit("login", credentials);
      this.logger.info("Login completed", { botId: credentials.botId, userId: credentials.userId });
      return credentials;
    } finally {
      this.loginAbortController = null;
      this.lastLoginResult = null;
    }
  }
  cancelLogin() {
    if (!this.loginAbortController) {
      return;
    }
    const controller = this.loginAbortController;
    this.loginAbortController = null;
    this.lastLoginResult = null;
    controller.abort();
    this.pendingLogin = createDeferred();
    this.logger.info("Login cancelled");
  }
  async start() {
    await this.store.ensure();
    if (!this.session.getCredentials()) {
      const stored = await this.store.loadCredentials(this.selectedAccountId ?? void 0);
      if (stored) {
        await this.applyCredentials(stored);
      }
    }
    this.startPoller();
  }
  stop() {
    this.cancelLogin();
    this.poller?.stop();
    this.poller = null;
  }
  async logout() {
    this.stop();
    const accountId = this.botId ? sanitizeAccountId(this.botId) : void 0;
    this.session.setCredentials(null);
    this.http.setCredentials(null);
    if (accountId) {
      await this.store.clearCredentials(accountId);
    }
    this.emit("logout", "manual_logout");
    this.logger.info("Manual logout");
  }
  on(event, listener) {
    return super.on(event, listener);
  }
  async listAccounts() {
    return this.store.listAccounts();
  }
  async sendText(toUserId, text, accountId) {
    const resolved = await this.resolveOutboundAccount(toUserId, accountId);
    const sender = this.createSenderForCredentials(resolved.credentials);
    await sender.replyText(toUserId, resolved.contextToken, this.decorateDebugText(text, resolved.accountId));
  }
  async sendImage(toUserId, filePath, accountId) {
    const resolved = await this.resolveOutboundAccount(toUserId, accountId);
    await this.sendMediaFromAccount(resolved.credentials, toUserId, resolved.contextToken, filePath);
  }
  async sendFile(toUserId, filePath, accountId) {
    const resolved = await this.resolveOutboundAccount(toUserId, accountId);
    await this.sendMediaFromAccount(resolved.credentials, toUserId, resolved.contextToken, filePath);
  }
  createReplyStream(message, options) {
    const credentials = this.session.assertActive();
    return new ReplyStream(this.sender, this.typing, message, credentials.botId, options);
  }
  startPoller() {
    const credentials = this.session.assertActive();
    const accountId = sanitizeAccountId(credentials.botId);
    this.poller?.stop();
    this.poller = new UpdatesPoller(this.http, {
      getCursor: () => this.store.loadCursor(accountId),
      saveCursor: (cursor) => this.store.saveCursor(accountId, cursor),
      onMessage: (raw) => this.handleRawMessage(raw),
      onLogout: async (reason) => this.handleLogout(reason),
      onError: (error) => {
        this.logger.error("Polling error", { message: error.message });
        this.emit("error", error);
      },
      getChannelVersion: () => this.channelVersion
    });
    void this.poller.start();
    this.logger.info("Polling started", { botId: credentials.botId });
  }
  async handleRawMessage(raw) {
    const credentials = this.session.assertActive();
    const accountId = sanitizeAccountId(credentials.botId);
    if (!await this.isAuthorized(accountId, raw.from_user_id)) {
      this.logger.debug("Dropping unauthorized message", { accountId, from: raw.from_user_id });
      return;
    }
    await this.store.saveContextToken(accountId, raw.from_user_id, raw.context_token);
    const message = createMessage(
      {
        credentials,
        sender: this.sender,
        saveContextToken: (userId, token) => this.store.saveContextToken(accountId, userId, token),
        createReplyStream: (incoming, options) => this.createReplyStream(incoming, options),
        replyImage: (incoming, filePath) => this.replyWithMedia(incoming, filePath),
        replyFile: (incoming, filePath) => this.replyWithMedia(incoming, filePath),
        downloadMedia: (incoming, destination) => this.downloadMedia(incoming, destination)
      },
      raw
    );
    if (await this.handleSlashCommand(message, accountId)) {
      return;
    }
    void this.messageQueue.add(async () => {
      const listeners = this.listeners("message");
      try {
        for (const listener of listeners) {
          await listener(message);
        }
      } catch (error) {
        this.logger.error("Message handler failed", { message: error.message });
        this.emit("error", error);
      }
    });
  }
  async applyCredentials(credentials) {
    this.session.setCredentials(credentials);
    this.session.clearPause();
    this.http.setCredentials(credentials);
    await this.store.saveCredentials(credentials);
    const accountId = sanitizeAccountId(credentials.botId);
    await this.store.addAllowFrom(accountId, credentials.userId);
    for (const userId of this.initialAllowFrom) {
      await this.store.addAllowFrom(accountId, userId);
    }
  }
  async handleLogout(reason) {
    this.session.pauseFor(36e5);
    this.emit("logout", reason);
    this.logger.warn("Session expired; starting re-login flow", { reason });
    if (reason !== "session_expired" || this.restarting) {
      return;
    }
    this.restarting = true;
    this.stop();
    try {
      await this.login();
      await this.waitForLogin();
      this.startPoller();
    } catch (error) {
      this.logger.error("Automatic re-login failed", { message: error.message });
      this.emit("error", error);
    } finally {
      this.restarting = false;
    }
  }
  async replyWithMedia(message, filePath) {
    await this.sendMediaFromAccount(this.session.assertActive(), message.userId, message.contextToken, filePath);
  }
  async sendMediaFromAccount(credentials, toUserId, contextToken, filePath) {
    const uploaded = await uploadMediaFile({
      http: this.createHttpForCredentials(credentials),
      filePath,
      toUserId,
      channelVersion: this.channelVersion,
      cdnBaseUrl: DEFAULT_CDN_BASE_URL
    });
    const sender = this.createSenderForCredentials(credentials);
    await sender.sendItems(toUserId, contextToken, [createMediaMessageItem(uploaded)]);
  }
  async downloadMedia(message, destination) {
    const item = message.items.find((entry) => entry.type !== 1);
    if (!item) {
      throw new Error("Message does not contain media");
    }
    return downloadMessageMedia({
      http: this.http,
      item,
      destination,
      rootDir: this.dataDir,
      cdnBaseUrl: DEFAULT_CDN_BASE_URL
    });
  }
  async isAuthorized(accountId, userId) {
    if (this.dmPolicy === "open") {
      return true;
    }
    const allowFrom = await this.store.getAllowFrom(accountId);
    return allowFrom.includes(userId);
  }
  async handleSlashCommand(message, accountId) {
    if (!message.text.startsWith("/")) {
      return false;
    }
    if (message.text.startsWith("/echo")) {
      const payload = message.text.slice("/echo".length).trim();
      const latency = Date.now() - message.timestamp.getTime();
      await message.reply(this.decorateDebugText(`${payload || "(empty)"}
[latency=${latency}ms]`, accountId));
      return true;
    }
    if (message.text.trim() === "/toggle-debug") {
      const enabled = !await this.store.getDebugMode(accountId);
      await this.store.setDebugMode(accountId, enabled);
      await message.reply(`debug mode ${enabled ? "enabled" : "disabled"}`);
      return true;
    }
    return false;
  }
  decorateDebugText(text, accountId) {
    return text;
  }
  createHttpForCredentials(credentials) {
    return new ILinkHttpClient({ credentials, baseUrl: credentials.baseUrl });
  }
  createSenderForCredentials(credentials) {
    const http = credentials.botId === this.botId ? this.http : this.createHttpForCredentials(credentials);
    return new MessageSender(http, () => credentials, () => this.channelVersion);
  }
  async resolveOutboundAccount(toUserId, accountId) {
    const allCredentials = await this.store.loadAllCredentials();
    const requestedAccountId = accountId ? sanitizeAccountId(accountId) : void 0;
    if (requestedAccountId) {
      const credentials = allCredentials.find((entry) => sanitizeAccountId(entry.botId) === requestedAccountId);
      if (!credentials) {
        throw new Error(`Unknown accountId: ${requestedAccountId}`);
      }
      const contextToken = await this.store.getContextToken(requestedAccountId, toUserId);
      if (!contextToken) {
        throw new Error(`No context token for ${toUserId} on account ${requestedAccountId}`);
      }
      return { accountId: requestedAccountId, credentials, contextToken };
    }
    const matches = [];
    for (const credentials of allCredentials) {
      const normalized = sanitizeAccountId(credentials.botId);
      const contextToken = await this.store.getContextToken(normalized, toUserId);
      if (contextToken) {
        matches.push({ accountId: normalized, credentials, contextToken });
      }
    }
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous account for ${toUserId}`);
    }
    throw new Error(`No account has an active context for ${toUserId}`);
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AgentLinkWechat,
  AuthError,
  ILinkError,
  ILinkHttpClient,
  LoginCancelledError,
  MediaError,
  Message,
  MessageItemType,
  MessageState,
  MessageType,
  NetworkError,
  ProtocolError,
  ReplyStream,
  Store,
  TypingIndicator,
  TypingStatus,
  UploadMediaType,
  createFileMessageItem,
  createImageMessageItem,
  createMediaEncryptionMaterial,
  createMediaMessageItem,
  createVideoMessageItem,
  decryptAes128Ecb,
  downloadMessageMedia,
  encryptAes128Ecb,
  parseAesKey,
  resolveDestination,
  uploadMediaFile
});
