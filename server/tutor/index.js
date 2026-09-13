const context = require("./context");
const chat = require("./chat");
const routes = require("./routes");

module.exports = {
  ...context,
  ...chat,
  ...routes,
};
