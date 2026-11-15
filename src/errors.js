'use strict';
// 共享错误类型：REST/WS 层据此映射状态码。

class GameError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

module.exports = { GameError };
