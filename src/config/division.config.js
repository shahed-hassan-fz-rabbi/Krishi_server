/**
 * Representative points from centroids of BBS administrative division polygons.
 * These are map/data request reference points, not division-wide averages.
 * Kept separate from DISTRICTS so ingestion and farm validation remain unchanged.
 */
export const DIVISIONS = [
  { code: "dhaka", nameEn: "Dhaka", nameBn: "ঢাকা", latitude: 23.83870, longitude: 90.24064 },
  { code: "chattogram", nameEn: "Chattogram", nameBn: "চট্টগ্রাম", latitude: 22.70692, longitude: 91.73546 },
  { code: "rajshahi", nameEn: "Rajshahi", nameBn: "রাজশাহী", latitude: 24.58846, longitude: 89.04540 },
  { code: "khulna", nameEn: "Khulna", nameBn: "খুলনা", latitude: 22.91367, longitude: 89.29437 },
  { code: "barishal", nameEn: "Barishal", nameBn: "বরিশাল", latitude: 22.41889, longitude: 90.34684 },
  { code: "sylhet", nameEn: "Sylhet", nameBn: "সিলেট", latitude: 24.71515, longitude: 91.66400 },
  { code: "rangpur", nameEn: "Rangpur", nameBn: "রংপুর", latitude: 25.77920, longitude: 89.05685 },
  { code: "mymensingh", nameEn: "Mymensingh", nameBn: "ময়মনসিংহ", latitude: 24.84675, longitude: 90.38088 },
].map((division) => ({
  ...division,
  pointMethod: "BBS division polygon centroid",
  limitation: "One representative point; conditions elsewhere in the division may differ.",
}));
