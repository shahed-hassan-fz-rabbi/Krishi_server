/**
 * Standalone probe script to verify NASA Earthdata credentials and SMAP granule availability.
 * Safe read-only inspection; does not write to live database collections without approval.
 */

import "dotenv/config";
import { isEarthdataConfigured, verifyEarthdataAuth } from "../services/nasa/earthdata.auth.js";
import { searchSmapGranules } from "../services/nasa/smap.client.js";

async function runProbe() {
  console.log("=================================================");
  console.log("   KRISHI MAMA — NASA SMAP & EARTHDATA PROBE     ");
  console.log("=================================================\n");

  const configured = isEarthdataConfigured();
  console.log(`[Earthdata Config] Credentials configured in server/.env: ${configured}`);

  if (configured) {
    console.log("[Earthdata Auth] Testing AppEEARS authentication token endpoint...");
    const authStatus = await verifyEarthdataAuth();
    console.log(`[Earthdata Auth] Result: ${authStatus.authenticated ? "SUCCESS" : "FAILED"}`);
    console.log(`[Earthdata Auth] Message: ${authStatus.message}`);
  } else {
    console.log("[Earthdata Auth] Skipped (credentials not yet provided in server/.env)\n");
  }

  console.log("[NASA CMR] Querying official SMAP SPL3SMP_E V006 granules over Bangladesh...");
  try {
    const granules = await searchSmapGranules({
      startDate: "2024-01-01",
      endDate: "2024-01-10",
      limit: 5,
    });
    console.log(`[NASA CMR] Successfully retrieved ${granules.length} granules for target coordinates.`);
    granules.forEach((g, idx) => {
      console.log(`  ${idx + 1}. Date: ${g.dateLabel} | Granule: ${g.title}`);
    });
  } catch (err) {
    console.error(`[NASA CMR] Granule search error: ${err.message}`);
  }

  console.log("\n=================================================");
  console.log("   PROBE COMPLETE                                ");
  console.log("=================================================");
}

runProbe().catch(console.error);
