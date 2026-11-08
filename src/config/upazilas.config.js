/**
 * Official BBS Upazila Registry for Supported Districts.
 * Grounded in Bangladesh Bureau of Statistics (BBS) 2020 Admin-3 boundaries.
 */

export const DISTRICT_UPAZILAS = {
  cumilla: [
    { code: "adarsha_sadar", nameEn: "Adarsha Sadar", nameBn: "আদর্শ সদর" },
    { code: "sadar_dakshin", nameEn: "Sadar Dakshin", nameBn: "সদর দক্ষিণ" },
    { code: "barura", nameEn: "Barura", nameBn: "বরুড়া" },
    { code: "brahmanpara", nameEn: "Brahmanpara", nameBn: "ব্রাহ্মণপাড়া" },
    { code: "burichang", nameEn: "Burichang", nameBn: "বুড়িচং" },
    { code: "chandina", nameEn: "Chandina", nameBn: "চান্দিনা" },
    { code: "chauddagram", nameEn: "Chauddagram", nameBn: "চৌদ্দগ্রাম" },
    { code: "daudkandi", nameEn: "Daudkandi", nameBn: "দাউদকান্দি" },
    { code: "debidwar", nameEn: "Debidwar", nameBn: "দেবিদ্বার" },
    { code: "homna", nameEn: "Homna", nameBn: "হোমনা" },
    { code: "laksam", nameEn: "Laksam", nameBn: "লাকসাম" },
    { code: "lalmai", nameEn: "Lalmai", nameBn: "লালমাই" },
    { code: "meghna", nameEn: "Meghna", nameBn: "মেঘনা" },
    { code: "monohargonj", nameEn: "Monohargonj", nameBn: "মনোহরগঞ্জ" },
    { code: "muradnagar", nameEn: "Muradnagar", nameBn: "মুরাদনগর" },
    { code: "nangalkot", nameEn: "Nangalkot", nameBn: "নাঙ্গলকোট" },
    { code: "titas", nameEn: "Titas", nameBn: "তিতাস" },
  ],
  chattogram: [
    { code: "anwara", nameEn: "Anwara", nameBn: "আনোয়ারা" },
    { code: "banshkhali", nameEn: "Banshkhali", nameBn: "বাঁশখালী" },
    { code: "boalkhali", nameEn: "Boalkhali", nameBn: "বোয়ালখালী" },
    { code: "chandanaish", nameEn: "Chandanaish", nameBn: "চন্দনাইশ" },
    { code: "fatikchhari", nameEn: "Fatikchhari", nameBn: "ফটিকছড়ি" },
    { code: "hathazari", nameEn: "Hathazari", nameBn: "হাটহাজারী" },
    { code: "karnaphuli", nameEn: "Karnaphuli", nameBn: "কর্ণফুলী" },
    { code: "lohagara", nameEn: "Lohagara", nameBn: "লোহাগাড়া" },
    { code: "mirsharai", nameEn: "Mirsharai", nameBn: "মীরসরাই" },
    { code: "patiya", nameEn: "Patiya", nameBn: "পটিয়া" },
    { code: "rangunia", nameEn: "Rangunia", nameBn: "রাঙ্গুনিয়া" },
    { code: "raozan", nameEn: "Raozan", nameBn: "রাউজান" },
    { code: "sandwip", nameEn: "Sandwip", nameBn: "সন্দ্বীপ" },
    { code: "satkania", nameEn: "Satkania", nameBn: "সাতকানিয়া" },
    { code: "sitakunda", nameEn: "Sitakunda", nameBn: "সীতাকুণ্ড" },
  ],
};

export function getUpazilasForDistrict(districtCode) {
  if (!districtCode) return [];
  const lower = districtCode.trim().toLowerCase();
  return DISTRICT_UPAZILAS[lower] || [];
}
