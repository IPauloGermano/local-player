// Ponto central de exportação dos submódulos do servidor (Server Architecture)
module.exports = {
  ...require("./core/titles"),
  ...require("./core/fs-atomic"),
  ...require("./core/security"),
  ...require("./services/document-extractors"),
  ...require("./services/web-search"),
  ...require("./ai/config"),
  ...require("./ai/skills"),
  ...require("./ai/study"),
  ...require("./ai/subtitles-helpers"),
};
