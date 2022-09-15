const path = require("path");
const fs = require("fs");
const fse = require("fs-extra");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");
const log4js = require("log4js");

const OS_PLATFORM = os.platform();

const OS_CPU_TOTAL = os.cpus().length;

const PROCESS_TOTAL = OS_CPU_TOTAL; // 并行数量

const RETRY_TOTAL = 10; // 失败重试次数

const BUILD_DIR = process.argv[2] || path.resolve(__dirname, "../build/jsb-link/assets/resources");

const TEMP_PATH = path.resolve(__dirname, "./temp");

const TEMP_MAP_PATH = path.resolve(TEMP_PATH, "temp.json");

const COMPRESS_TYPE = process.argv[3] || "etc1";

const COCOS_TYPE_MAP = {
  etc1: "6@1026,",
  etc2: "6@29,",
};

const WORKER_MAP = {};

const imagePathList = [];

const imageErrorList = [];

// 缓存 Map
let tempMap = {
  etc1: {},
  etc2: {},
};

let tempHitCount = 0;

log4js.configure({
  appenders: {
    out: { type: "stdout" },
    app: {
      type: "dateFile",
      pattern: "yyyy-MM-dd.log",
      alwaysIncludePattern: true, // 是否总是有后缀名
      filename: path.resolve(__dirname, "./log/log"),
    },
  },
  categories: {
    default: { appenders: ["out", "app"], level: "debug" },
  },
});

const logger = log4js.getLogger();

// 获取 sha1
function getSha1(buffer) {
  const shasum = crypto.createHash("sha1");
  shasum.update(buffer);
  return shasum.digest("hex");
}

// 获取图片对应的 json 路径
function getImageJSONPath(imagePathInfo) {
  return path.resolve(
    imagePathInfo.dir.replace("native", "import"),
    `${imagePathInfo.name}.json`
  );
}

// 根据并行数创建 worker
function createWorkerList() {
  fse.removeSync(path.resolve(__dirname, "./worker"));

  const copyList = [];

  let etcpackPath = "";

  if (/win32/.test(OS_PLATFORM)) {
    etcpackPath = path.resolve(__dirname, "./mali/Windows_64/");
  } else {
    etcpackPath = path.resolve(__dirname, "./mali/OSX_x86/");
  }

  for (let i = 0; i < PROCESS_TOTAL; i++) {
    const workerPath = path.resolve(__dirname, `./worker/${i}`);

    copyList.push(fse.copy(etcpackPath, workerPath));

    WORKER_MAP[i] = {
      PATH: workerPath,
      working: false,
    };
  }

  return Promise.all(copyList);
}

// 获取项目图片列表
function getImageListData() {
  const dirList = [BUILD_DIR];

  while (dirList.length > 0) {
    const rootPath = dirList.shift();
    const list = fs.readdirSync(rootPath);

    list.forEach((dirName) => {
      const imageFilePath = path.join(rootPath, dirName);
      const imageStatInfo = fs.statSync(imageFilePath);
      const imagePathInfo = path.parse(imageFilePath);
      if (imageStatInfo.isDirectory()) {
        dirList.push(imageFilePath);
      } else if (/(\.png|\.jpg)/i.test(imagePathInfo.ext)) {
        const jsonPath = getImageJSONPath(imagePathInfo);

        if (fs.existsSync(jsonPath)) {
          imagePathList.push(imagePathInfo);
        } else {
          imageErrorList.push(imagePathInfo);
        }
      }
    });
  }

  return {
    imagePathList,
    imageErrorList,
  };
}

// 压缩纹理
function createETC(imagePathInfo, workerInfo) {
  return new Promise((resolve, reject) => {
    try {
      logger.info(
        "========== 开始生成 ETC ==========",
        path.format(imagePathInfo)
      );

      const imagePath = path.format(imagePathInfo);

      const imageSha1 = getSha1(fs.readFileSync(imagePath));

      const etcpack = () => {
        workerInfo.working = true;

        let shell = "";

        let paramList = [];

        const imageFormat = imagePathInfo.ext.replace(".", "").toUpperCase();

        if (/win32/.test(OS_PLATFORM)) {
          shell = "etcpack.exe";
        } else {
          shell = `${workerInfo.PATH}/etcpack`;
        }

        if (COMPRESS_TYPE === "etc1") {
          paramList = [
            imagePath,
            path.resolve(TEMP_PATH, COMPRESS_TYPE),
            "-c",
            "etc1",
            "-s",
            "slow",
            "-aa",
            "-ext",
            imageFormat,
          ];
        } else if (COMPRESS_TYPE === "etc2") {
          paramList = [
            imagePath,
            path.resolve(TEMP_PATH, COMPRESS_TYPE),
            "-c",
            "etc2",
            "-s",
            "slow",
            "-f",
            "RGBA",
            "-ext",
            imageFormat,
          ];
        }

        let { env } = process;

        if (!/win32/.test(OS_PLATFORM)) {
          env = Object.assign({}, env, {
            PATH: `${workerInfo.PATH}:${env.PATH}`,
          });
        }

        const shellProgress = spawn(shell, paramList, {
          env,
          encoding: "utf8",
          cwd: workerInfo.PATH,
        });

        shellProgress.stdout.on("data", (data) => {
          const log = data.toString("utf8");

          logger.info(log);
        });

        shellProgress.stderr.on("data", (data) => {
          logger.error(data.toString("utf8"));
        });

        shellProgress.on("close", (code) => {
          workerInfo.working = false;

          if (code === 0) {
            tempMap[COMPRESS_TYPE][
              imageSha1
            ] = `${COMPRESS_TYPE}/${imagePathInfo.name}.pkm`;
            resolve(
              path.resolve(
                TEMP_PATH,
                COMPRESS_TYPE,
                `${imagePathInfo.name}.pkm`
              )
            );
          } else {
            reject();
          }
        });
      };

      if (tempMap[COMPRESS_TYPE][imageSha1]) {
        if (
          fs.existsSync(
            path.resolve(TEMP_PATH, tempMap[COMPRESS_TYPE][imageSha1])
          )
        ) {
          logger.info(
            "========== 命中缓存 ==========",
            path.format(imagePathInfo)
          );

          tempHitCount += 1;

          resolve(path.resolve(TEMP_PATH, tempMap[COMPRESS_TYPE][imageSha1]));
        } else {
          etcpack();
        }
      } else {
        etcpack();
      }
    } catch (error) {
      logger.error(error);
      reject();
    }
  });
}

// 替换纹理图片
function replaceImage(imagePathInfo, pkmPath) {
  return new Promise((resolve, reject) => {
    try {
      logger.info("========== 开始替换图片 ==========", pkmPath);

      const jsonPath = getImageJSONPath(imagePathInfo);
      const imagePath = path.format(imagePathInfo);

      fs.copyFileSync(pkmPath, imagePath.replace(imagePathInfo.ext, ".pkm"));

      const imageJSON = JSON.parse(fs.readFileSync(jsonPath));

      imageJSON[5][0] = imageJSON[5][0].replace(
        /^(0,|1,)/,
        COCOS_TYPE_MAP[COMPRESS_TYPE]
      );

      fs.writeFileSync(jsonPath, JSON.stringify(imageJSON, 0, 2));

      fs.unlinkSync(imagePath);

      resolve(imagePathInfo);
    } catch (error) {
      logger.error(error);
      reject();
    }
  });
}

// 图片并行处理
function processImageList(pathList) {
  return new Promise((resolve) => {
    const total = pathList.length;

    let successCount = 0;

    const errorList = [];

    const getIdleWorker = () => {
      for (const workerID in WORKER_MAP) {
        if (!WORKER_MAP[workerID].working) {
          return WORKER_MAP[workerID];
        }
      }
    };

    const processImage = () => {
      logger.info(
        `========== 处理进度 ${Math.floor(
          (successCount / total) * 100
        )}% ${successCount}/${total} ==========`
      );

      if (successCount + errorList.length === total) {
        resolve({
          successCount,
          errorList,
        });
      } else if (pathList.length > 0) {
        const imagePathInfo = pathList.shift();

        const workerInfo = getIdleWorker();

        createETC(imagePathInfo, workerInfo)
          .then((pkmPath) => replaceImage(imagePathInfo, pkmPath))
          .then(() => {
            logger.info(
              "========== 处理完成 ==========",
              path.format(imagePathInfo)
            );
            successCount += 1;
            processImage();

            return;
          })
          .catch(() => {
            logger.info(
              "========== 处理异常 ==========",
              path.format(imagePathInfo)
            );

            imagePathInfo.retryNum = (imagePathInfo.retryNum || 0) + 1;

            if (imagePathInfo.retryNum < RETRY_TOTAL) {
              pathList.push(imagePathInfo);
            } else {
              logger.info(imagePathInfo);
              errorList.push(imagePathInfo);
            }

            processImage();

            return;
          });
      }
    };

    for (let i = 0; i < PROCESS_TOTAL; i++) {
      processImage();
    }
  });
}

async function main() {
  const startTime = new Date();

  logger.info("========== 开始压缩纹理 ==========");

  logger.info(`========== CPU 核数 ${OS_CPU_TOTAL} ==========`);

  logger.info("========== 开始创建 worker ==========");

  await createWorkerList();

  logger.info("========== 完成创建 worker ==========");

  logger.info("========== 开始扫描项目图片 ==========");

  getImageListData();

  logger.info(
    `========== 扫描到 ${imagePathList.length} 个图片, ${imageErrorList.length} 个异常图片 ==========`
  );

  if (imageErrorList.length > 0) {
    logger.info("========== 异常图片列表 ==========");

    logger.info(
      imageErrorList.map((imagePathInfo) => path.format(imagePathInfo))
    );
  }

  logger.info("========== 开始处理项目图片 ==========");

  fse.ensureDirSync(path.resolve(TEMP_PATH, COMPRESS_TYPE));

  if (fs.existsSync(TEMP_MAP_PATH)) {
    tempMap = require(TEMP_MAP_PATH);
  }

  const { successCount, errorList } = await processImageList(imagePathList);

  logger.info(
    `========== 处理图片完成, 成功 ${successCount} 个, 失败 ${errorList.length} 个, 命中缓存 ${tempHitCount} 个 ==========`
  );

  logger.info("========== 失败列表 ==========");

  logger.info(errorList.map((imagePageInfo) => path.format(imagePageInfo)));

  logger.info("========== 生成缓存表 ==========");

  fse.writeJsonSync(TEMP_MAP_PATH, tempMap);

  const endTime = new Date();

  logger.info(
    `========== 压缩纹理结束 耗时 ${(endTime - startTime) / 1000}s  ==========`
  );
}

main();
