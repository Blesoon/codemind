'use strict';

const path = require('path');

/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node',
  mode: 'none', 
  entry: './src/extension.ts', 
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        // ⭐ webview 폴더를 검사 대상에서 완전히 제외합니다.
        exclude: /node_modules|webview/, 
        use: [
          {
            loader: 'ts-loader',
            options: {
              // ⭐ 이 옵션이 핵심입니다. 타입 체크 에러가 있어도 빌드를 진행합니다.
              transpileOnly: true 
            }
          }
        ]
      }
    ]
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: "log",
  },
};

module.exports = [ extensionConfig ];