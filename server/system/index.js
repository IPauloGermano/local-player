// Ponto de entrada do submódulo system/

module.exports = {
  ...require("./status"),
  ...require("./shortcuts"),
  ...require("./lifecycle"),
  ...require("./routes"),
};
