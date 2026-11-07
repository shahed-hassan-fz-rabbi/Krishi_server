/**
 * Climate Analysis Service.
 * Bridges MongoDB observations with the Python scientific processing engine.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NasaObservation } from "../../models/nasaobservation.model.js";
import { DISTRICTS, PARAMETER_NAMES, TARGET_RANGE } from "../../config/climate.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCIENCE_DIR = path.resolve(__dirname, "../../../science");
const PYTHON_RUN_SCRIPT = path.join(SCIENCE_DIR, "run.py");

/**
 * Creates a JSON snapshot of MongoDB observations for Python processing.
 */
export async function createObservationSnapshot({
  districtCode,
  parameters = PARAMETER_NAMES,
  startIso = TARGET_RANGE.start,
  endIso = TARGET_RANGE.end,
}) {
  const query = {
    districtCode,
    parameter: { $in: parameters },
    dateLabel: { $gte: startIso, $lte: endIso },
  };

  const observations = await NasaObservation.find(query)
    .select("parameter dateLabel value quality sentinelValue unit timeStandard -_id")
    .sort({ dateLabel: 1 })
    .lean();

  return {
    district: districtCode,
    parameters,
    dateRange: { start: startIso, end: endIso },
    count: observations.length,
    observations,
  };
}

/**
 * Executes the Python scientific processing CLI via stdin/stdout IPC.
 */
export async function executePythonAnalysis({ snapshot, parameter = null }) {
  return new Promise((resolve, reject) => {
    const args = [
      PYTHON_RUN_SCRIPT,
      "summarize",
      "--district",
      snapshot.district,
      "--input",
      "-",
    ];

    if (parameter) {
      args.push("--parameter", parameter);
    }

    const pyProcess = spawn("python", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdoutData = "";
    let stderrData = "";

    pyProcess.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString("utf8");
    });

    pyProcess.stderr.on("data", (chunk) => {
      stderrData += chunk.toString("utf8");
    });

    pyProcess.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`Python process exited with code ${code}: ${stderrData || "unknown error"}`)
        );
      }

      try {
        const result = JSON.parse(stdoutData);
        resolve(result);
      } catch (parseError) {
        reject(new Error(`Failed to parse Python scientific output: ${parseError.message}`));
      }
    });

    pyProcess.on("error", (err) => {
      reject(new Error(`Failed to start Python process: ${err.message}`));
    });

    pyProcess.stdin.on("error", () => {
      /* process may have exited early, handled by on("close") */
    });

    pyProcess.stdin.write(JSON.stringify(snapshot));
    pyProcess.stdin.end();
  });
}

/**
 * High-level analysis pipeline for a district.
 */
export async function analyzeDistrictClimate({
  districtCode,
  parameter = null,
  parameters = null,
  startIso = TARGET_RANGE.start,
  endIso = TARGET_RANGE.end,
}) {
  let targetParameters;
  if (parameters) {
    targetParameters = parameters;
  } else if (parameter === "T2M") {
    targetParameters = ["T2M", "T2M_MAX", "T2M_MIN"];
  } else if (parameter) {
    targetParameters = [parameter];
  } else {
    targetParameters = PARAMETER_NAMES;
  }

  const snapshot = await createObservationSnapshot({
    districtCode,
    parameters: targetParameters,
    startIso,
    endIso,
  });

  return executePythonAnalysis({ snapshot, parameter });
}

/**
 * Executes the Python scientific handoff CLI via stdin/stdout IPC.
 */
export async function executePythonHandoff({ snapshot, cropTransition = "aman-mustard" }) {
  return new Promise((resolve, reject) => {
    const args = [
      PYTHON_RUN_SCRIPT,
      "handoff",
      "--district",
      snapshot.district,
      "--crop-transition",
      cropTransition,
      "--input",
      "-",
    ];

    const pyProcess = spawn("python", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdoutData = "";
    let stderrData = "";

    pyProcess.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString("utf8");
    });

    pyProcess.stderr.on("data", (chunk) => {
      stderrData += chunk.toString("utf8");
    });

    pyProcess.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`Python process exited with code ${code}: ${stderrData || "unknown error"}`)
        );
      }

      try {
        const result = JSON.parse(stdoutData);
        resolve(result);
      } catch (parseError) {
        reject(new Error(`Failed to parse Python scientific handoff output: ${parseError.message}`));
      }
    });

    pyProcess.on("error", (err) => {
      reject(new Error(`Failed to start Python process: ${err.message}`));
    });

    pyProcess.stdin.on("error", () => {
      /* process may have exited early, handled by on("close") */
    });

    pyProcess.stdin.write(JSON.stringify(snapshot));
    pyProcess.stdin.end();
  });
}

/**
 * High-level handoff planning analysis for crop transition.
 */
export async function analyzeHandoff({
  districtCode,
  cropTransition = "aman-mustard",
  startIso = TARGET_RANGE.start,
  endIso = TARGET_RANGE.end,
}) {
  const snapshot = await createObservationSnapshot({
    districtCode,
    parameters: ["PRECTOTCORR", "T2M_MIN", "T2M", "RH2M"],
    startIso,
    endIso,
  });

  return executePythonHandoff({ snapshot, cropTransition });
}
