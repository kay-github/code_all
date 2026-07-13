"use strict";

const {
  closeStaticServer,
  startStaticServer
} = require("./static-server");

module.exports = async function globalSetup() {
  const server = await startStaticServer();
  return async () => closeStaticServer(server);
};
