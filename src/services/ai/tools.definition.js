/**
 * Krishi Mama AI Assistant — Gemini Tool Definitions (Function Declarations).
 * Enforces structured tool calling for NASA and official Bangladesh agricultural datasets.
 */

export const assistantTools = [
  {
    name: "getPrecipitationLatest",
    description: "Retrieve the latest stored NASA GPM IMERG Final V07 precipitation observation and daily summary. The daily total is present only when all 48 unique Bangladesh-local half-hour intervals are valid; disclose observation date, source, ~0.1 degree spatial resolution, coverage, and limitations. Never describe this as live weather or a farm rain-gauge measurement.",
    parameters: { type: "OBJECT", properties: { district: { type: "STRING", description: "Target district code: 'cumilla' or 'chattogram'." } }, required: ["district"] },
  },
  {
    name: "getClimateNormals",
    description:
      "Retrieve 2001-2025 monthly historical baseline averages for rainfall (PRECTOTCORR) and temperature (T2M) for an approved district in Bangladesh from NASA POWER reanalysis.",
    parameters: {
      type: "OBJECT",
      properties: {
        district: {
          type: "STRING",
          description: "Target district code in lowercase. Currently approved: 'cumilla', 'chattogram'.",
        },
        month: {
          type: "INTEGER",
          description: "Optional specific month number (1 to 12). If omitted, returns all 12 monthly normals.",
        },
      },
      required: ["district"],
    },
  },
  {
    name: "getClimateRainfall",
    description:
      "Retrieve aggregated historical rainfall statistics, seasonal distributions, or annual precipitation totals for an approved district from NASA POWER.",
    parameters: {
      type: "OBJECT",
      properties: {
        district: {
          type: "STRING",
          description: "Target district code in lowercase. Currently approved: 'cumilla', 'chattogram'.",
        },
        grouping: {
          type: "STRING",
          description: "Aggregation grouping: 'annual', 'monthly', or 'seasonal'. Defaults to 'annual'.",
        },
      },
      required: ["district"],
    },
  },
  {
    name: "getSoilMoistureLatest",
    description:
      "Fetch the latest validated NASA SMAP (Soil Moisture Active Passive) satellite volumetric surface soil moisture observation and quality flag for an approved district.",
    parameters: {
      type: "OBJECT",
      properties: {
        district: {
          type: "STRING",
          description: "Target district code in lowercase. Currently approved: 'cumilla', 'chattogram'.",
        },
      },
      required: ["district"],
    },
  },
  {
    name: "getVegetationLatest",
    description:
      "Fetch the latest validated NASA MODIS (MOD13Q1) 250m satellite vegetation greenness indices (NDVI and EVI) and pixel reliability rank for an approved district.",
    parameters: {
      type: "OBJECT",
      properties: {
        district: {
          type: "STRING",
          description: "Target district code in lowercase. Currently approved: 'cumilla', 'chattogram'.",
        },
      },
      required: ["district"],
    },
  },
  {
    name: "getCropCalendarAdvisory",
    description:
      "Retrieve official Bangladesh agricultural calendar information from BAMIS, DAE, BRRI, and BARI. Includes sowing periods, transplanting windows, growth stage durations, temperature limits, and water requirements.",
    parameters: {
      type: "OBJECT",
      properties: {
        crop: {
          type: "STRING",
          description:
            "Target crop code. Supported: 'monsoon_aman' (T. Aman), 'boro_rice' (Boro), 'aus_rice' (Aus), 'mustard' (সরিষা).",
        },
        district: {
          type: "STRING",
          description: "Target district code ('cumilla', 'chattogram').",
        },
        stage: {
          type: "STRING",
          description: "Optional specific growth stage (e.g., 'sowing', 'transplanting', 'flowering', 'harvesting').",
        },
      },
      required: ["crop"],
    },
  },
  {
    name: "getHandoffPlan",
    description:
      "Run the statistical Handoff Window Planner evaluating historical climate viability, sowing opportunity probability, and late-season rainfall shifts for sequential crop transitions.",
    parameters: {
      type: "OBJECT",
      properties: {
        transition: {
          type: "STRING",
          description: "Target transition pair: 'aman-mustard' (Aman to Mustard) or 'boro-aus' (Boro to Aus).",
        },
        district: {
          type: "STRING",
          description: "Target district code ('cumilla', 'chattogram'). Defaults to 'cumilla'.",
        },
      },
      required: ["transition"],
    },
  },
  {
    name: "getSupportedDistrictsAndCrops",
    description:
      "Retrieve the list of approved administrative districts, official crop types, and transition models currently configured and validated in Krishi Mama.",
    parameters: {
      type: "OBJECT",
      properties: {},
    },
  },
  {
    name: "getMyFarmDetails",
    description:
      "Retrieve profile, variety, acreage, planting date, and location of the authenticated farmer's specific farm.",
    parameters: {
      type: "OBJECT",
      properties: {
        farmId: {
          type: "STRING",
          description: "Target farm ObjectId.",
        },
      },
      required: ["farmId"],
    },
  },
  {
    name: "getMyFarmLifecycle",
    description:
      "Retrieve the phenological growth lifecycle stages, current stage, days since planting, and upcoming estimated stage transitions for the farmer's farm.",
    parameters: {
      type: "OBJECT",
      properties: {
        farmId: {
          type: "STRING",
          description: "Target farm ObjectId.",
        },
      },
      required: ["farmId"],
    },
  },
  {
    name: "getMyFarmActivities",
    description:
      "Retrieve scheduled, pending, upcoming, or completed farm activities and tasks for the farmer's farm.",
    parameters: {
      type: "OBJECT",
      properties: {
        farmId: {
          type: "STRING",
          description: "Target farm ObjectId.",
        },
        status: {
          type: "STRING",
          description: "Optional activity status filter ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED').",
        },
      },
      required: ["farmId"],
    },
  },
  {
    name: "getMyFarmEnvironmentalContext",
    description:
      "Retrieve localized NASA environmental intelligence for the farm, combining latest SMAP soil moisture, MODIS vegetation greenness, and NASA POWER climate baselines.",
    parameters: {
      type: "OBJECT",
      properties: {
        farmId: {
          type: "STRING",
          description: "Target farm ObjectId.",
        },
      },
      required: ["farmId"],
    },
  },
  {
    name: "getOfficialCropGuidance",
    description:
      "Retrieve official BAMIS / DAE / BRRI / BARI agronomic recommendations, optimal temperature, water requirement, and weather hazards for a specific crop and stage.",
    parameters: {
      type: "OBJECT",
      properties: {
        cropCode: {
          type: "STRING",
          description: "Target crop code: 'monsoon_aman', 'boro_rice', 'aus_rice', or 'mustard'.",
        },
        districtCode: {
          type: "STRING",
          description: "Target district code: 'cumilla' or 'chattogram'.",
        },
        stageCode: {
          type: "STRING",
          description: "Optional stage code (e.g., 'sowing', 'vegetative', 'flowering', 'ripening').",
        },
      },
      required: ["cropCode", "districtCode"],
    },
  },
  {
    name: "getFarmActivityHistory",
    description:
      "Retrieve completed or skipped activity history, completion notes, and timestamps for the farmer's farm.",
    parameters: {
      type: "OBJECT",
      properties: {
        farmId: {
          type: "STRING",
          description: "Target farm ObjectId.",
        },
      },
      required: ["farmId"],
    },
  },
];
