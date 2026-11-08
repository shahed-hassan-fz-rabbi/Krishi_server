/**
 * AppEEARS Point Task Submission Job for MODIS MOD13Q1.061.
 * Submits point task for Cumilla and Chattogram reference coordinates.
 */

import dotenv from "dotenv";
import {
  isAppeearsConfigured,
  submitAppeearsPointTask,
  getAppeearsTaskStatus,
} from "../services/nasa/appeears.client.js";

dotenv.config();

async function runTaskSubmission() {
  if (!isAppeearsConfigured()) {
    console.error("\n[auth] EARTHDATA_USERNAME and EARTHDATA_PASSWORD are not configured in server/.env.");
    console.error("Please add your NASA Earthdata login credentials locally in server/.env:");
    console.error("  EARTHDATA_USERNAME=your_username");
    console.error("  EARTHDATA_PASSWORD=your_password\n");
    process.exit(1);
  }

  try {
    console.log("[task] Authenticating with NASA AppEEARS via official login endpoint...");
    const taskResponse = await submitAppeearsPointTask({
      taskName: `krishi_mama_modis_point_${Date.now()}`,
      startDate: "01-01-2024",
      endDate: "01-31-2024",
      coordinates: [
        { id: "cumilla", latitude: 23.46186, longitude: 91.18503, category: "district_ref" },
        { id: "chattogram", latitude: 22.3384, longitude: 91.8317, category: "district_ref" },
      ],
    });

    console.log("[task] AppEEARS Point Task submitted successfully!");
    console.log(`Task ID: ${taskResponse.task_id}`);
    console.log(`Status: ${taskResponse.status}`);

    const status = await getAppeearsTaskStatus(taskResponse.task_id);
    console.log(`[status] Progress: ${status.progress?.percent || 0}% | State: ${status.status}`);
  } catch (err) {
    console.error("[error] Task submission failed:", err.message);
    process.exit(1);
  }
}

runTaskSubmission();
