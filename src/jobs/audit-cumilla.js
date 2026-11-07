import "../config/env.config.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { NasaObservation } from "../models/nasaobservation.model.js";

async function run() {
  await connectDatabase({ required: true });
  const count = await NasaObservation.countDocuments({ districtCode: "cumilla" });
  console.log("Total Cumilla observations:", count);

  const byParam = await NasaObservation.aggregate([
    { $match: { districtCode: "cumilla" } },
    { $group: { _id: "$parameter", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  console.log("Parameters in Cumilla:", byParam);

  const octNovRain = await NasaObservation.countDocuments({
    districtCode: "cumilla",
    parameter: "PRECTOTCORR",
    dateLabel: { $regex: "-(10|11)-" },
  });
  console.log("Oct-Nov rainfall records in Cumilla (25 years * 61 days):", octNovRain, "Expected:", 25 * 61);

  const novSowingRain = await NasaObservation.countDocuments({
    districtCode: "cumilla",
    parameter: "PRECTOTCORR",
    dateLabel: { $regex: "-11-(0[1-9]|1[0-9]|20)$" },
  });
  console.log("Nov 1-20 sowing records in Cumilla (25 years * 20 days):", novSowingRain, "Expected:", 25 * 20);

  await disconnectDatabase();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
