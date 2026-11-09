import test from "node:test";
import assert from "node:assert/strict";
import { buildGpmOpendapUrl, parseGpmOpendapAscii } from "../src/services/nasa/gpm.opendap.js";

const granuleId = "3B-HHR.MS.MRG.3IMERG.20240101-S000000-E002959.0000.V07B.HDF5";

function makeAscii({ rate = 0, quality = 0.63, error = 0.24, probability = 100 } = {}) {
  const lines = [`Dataset: ${granuleId}`];
  for (const [name, value] of [
    ["precipitationQualityIndex", quality],
    ["precipitation", rate],
    ["probabilityLiquidPrecipitation", probability],
    ["randomError", error],
  ]) {
    for (let x = 0; x < 8; x += 1) {
      const row = Array(12).fill(value).join(", ");
      lines.push(`${name}[0][${x}], ${row}`);
    }
  }
  lines.push("time_bnds[0], 1388102400, 1388104200", "lat, 22.35, 22.45, 22.55, 22.65, 22.75, 22.85, 22.95, 23.05, 23.15, 23.25, 23.35, 23.45", "lon, 91.15, 91.25, 91.35, 91.45, 91.55, 91.65, 91.75, 91.85", "time, 1388102400");
  return lines.join("\n");
}

test("regional OPeNDAP parser returns two point observations with provenance hash", () => {
  const parsed = parseGpmOpendapAscii(makeAscii(), { granuleId });
  assert.equal(parsed.observations.length, 2);
  assert.equal(parsed.observations[0].precipitationRateMmHr, 0);
  assert.equal(parsed.observations[0].precipitationMm, 0);
  assert.equal(parsed.observations[0].dateLabel, "2024-01-01");
  assert.equal(parsed.observations[0].longitude, 91.15);
  assert.equal(parsed.observations[1].longitude, 91.85);
  assert.equal(parsed.responseSha256.length, 64);
});

test("OPeNDAP parser preserves fill as null and rejects incomplete grids or wrong time bounds", () => {
  const fill = makeAscii({ rate: -9999.9, quality: -9999.9, error: -9999.9, probability: -9999 });
  const parsed = parseGpmOpendapAscii(fill, { granuleId });
  assert.equal(parsed.observations[0].sourceQuality, "missing_fill");
  assert.equal(parsed.observations[0].precipitationMm, null);
  assert.equal(parsed.observations[0].precipitationQualityIndex, null);
  assert.throws(() => parseGpmOpendapAscii(makeAscii().replace("time_bnds[0], 1388102400, 1388104200", "time_bnds[0], 1388102400, 1388106000"), { granuleId }), /time bounds/);
  assert.throws(() => parseGpmOpendapAscii(makeAscii().replace("lat, 22.35", "lat, 22.35").replace(/lat,.*\n/, "lat, 22.35\n"), { granuleId }), /coordinates/);
});

test("OPeNDAP URL is bounded, targets only V07B granules, and requests required fields once", () => {
  const url = new URL(buildGpmOpendapUrl({ producer_granule_id: granuleId }));
  assert.equal(url.hostname, "gpm1.gesdisc.eosdis.nasa.gov");
  assert.match(url.pathname, /2024\/001\/.*\.HDF5\.ascii$/);
  assert.match(url.search, /precipitationQualityIndex/);
  assert.throws(() => buildGpmOpendapUrl({ producer_granule_id: granuleId.replace("V07B", "V07A") }), /Final V07B/);
});
