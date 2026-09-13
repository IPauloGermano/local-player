const workspace = require("./workspace");
const vtt = require("./vtt");
const postprocess = require("./postprocess");
const editor = require("./editor");
const pipeline = require("./pipeline");
const routes = require("./routes");

module.exports = {
  ...workspace,
  ...vtt,
  ...postprocess,
  ...editor,
  ...pipeline,
  ...routes,
};
