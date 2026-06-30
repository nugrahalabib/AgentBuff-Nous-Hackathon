// Country + city option data for the onboarding "Kenalan" step. Proper nouns,
// language-stable, so they live here (like archetypes) rather than the i18n
// dictionary. The wizard renders them in a dropdown; a "Lainnya → ketik"
// fallback (handled by the SelectWithOther primitive) covers anything missing.
//
// City list cascades on the selected country. Indonesia (the core market) has a
// full list; other countries fall back to type-it-yourself.

export interface Option {
  id: string;
  label: string;
}

// Indonesia first (default market), then common destinations + a broad set.
export const COUNTRIES: readonly Option[] = [
  { id: "id", label: "Indonesia" },
  { id: "my", label: "Malaysia" },
  { id: "sg", label: "Singapura" },
  { id: "bn", label: "Brunei Darussalam" },
  { id: "th", label: "Thailand" },
  { id: "ph", label: "Filipina" },
  { id: "vn", label: "Vietnam" },
  { id: "kh", label: "Kamboja" },
  { id: "mm", label: "Myanmar" },
  { id: "la", label: "Laos" },
  { id: "tl", label: "Timor Leste" },
  { id: "au", label: "Australia" },
  { id: "nz", label: "Selandia Baru" },
  { id: "jp", label: "Jepang" },
  { id: "kr", label: "Korea Selatan" },
  { id: "cn", label: "Tiongkok" },
  { id: "hk", label: "Hong Kong" },
  { id: "tw", label: "Taiwan" },
  { id: "in", label: "India" },
  { id: "pk", label: "Pakistan" },
  { id: "bd", label: "Bangladesh" },
  { id: "lk", label: "Sri Lanka" },
  { id: "sa", label: "Arab Saudi" },
  { id: "ae", label: "Uni Emirat Arab" },
  { id: "qa", label: "Qatar" },
  { id: "kw", label: "Kuwait" },
  { id: "tr", label: "Turki" },
  { id: "eg", label: "Mesir" },
  { id: "za", label: "Afrika Selatan" },
  { id: "ng", label: "Nigeria" },
  { id: "us", label: "Amerika Serikat" },
  { id: "ca", label: "Kanada" },
  { id: "mx", label: "Meksiko" },
  { id: "br", label: "Brasil" },
  { id: "gb", label: "Inggris" },
  { id: "ie", label: "Irlandia" },
  { id: "de", label: "Jerman" },
  { id: "nl", label: "Belanda" },
  { id: "fr", label: "Prancis" },
  { id: "es", label: "Spanyol" },
  { id: "it", label: "Italia" },
  { id: "pt", label: "Portugal" },
  { id: "ch", label: "Swiss" },
  { id: "se", label: "Swedia" },
  { id: "no", label: "Norwegia" },
  { id: "dk", label: "Denmark" },
  { id: "fi", label: "Finlandia" },
  { id: "pl", label: "Polandia" },
  { id: "ru", label: "Rusia" },
] as const;

// Major Indonesian cities / provincial capitals.
const ID_CITIES: readonly Option[] = [
  { id: "jakarta", label: "Jakarta" },
  { id: "surabaya", label: "Surabaya" },
  { id: "bandung", label: "Bandung" },
  { id: "medan", label: "Medan" },
  { id: "semarang", label: "Semarang" },
  { id: "makassar", label: "Makassar" },
  { id: "palembang", label: "Palembang" },
  { id: "tangerang", label: "Tangerang" },
  { id: "depok", label: "Depok" },
  { id: "bekasi", label: "Bekasi" },
  { id: "bogor", label: "Bogor" },
  { id: "batam", label: "Batam" },
  { id: "pekanbaru", label: "Pekanbaru" },
  { id: "bandar-lampung", label: "Bandar Lampung" },
  { id: "padang", label: "Padang" },
  { id: "malang", label: "Malang" },
  { id: "denpasar", label: "Denpasar" },
  { id: "samarinda", label: "Samarinda" },
  { id: "banjarmasin", label: "Banjarmasin" },
  { id: "pontianak", label: "Pontianak" },
  { id: "balikpapan", label: "Balikpapan" },
  { id: "jambi", label: "Jambi" },
  { id: "surakarta", label: "Surakarta (Solo)" },
  { id: "manado", label: "Manado" },
  { id: "yogyakarta", label: "Yogyakarta" },
  { id: "mataram", label: "Mataram" },
  { id: "kupang", label: "Kupang" },
  { id: "ambon", label: "Ambon" },
  { id: "jayapura", label: "Jayapura" },
  { id: "palu", label: "Palu" },
  { id: "kendari", label: "Kendari" },
  { id: "gorontalo", label: "Gorontalo" },
  { id: "sorong", label: "Sorong" },
  { id: "bengkulu", label: "Bengkulu" },
  { id: "serang", label: "Serang" },
  { id: "cirebon", label: "Cirebon" },
  { id: "tasikmalaya", label: "Tasikmalaya" },
  { id: "sukabumi", label: "Sukabumi" },
] as const;

const CITIES_BY_COUNTRY: Record<string, readonly Option[]> = {
  id: ID_CITIES,
  sg: [{ id: "singapore", label: "Singapura" }],
  my: [
    { id: "kuala-lumpur", label: "Kuala Lumpur" },
    { id: "johor-bahru", label: "Johor Bahru" },
    { id: "penang", label: "Penang" },
    { id: "ipoh", label: "Ipoh" },
    { id: "kuching", label: "Kuching" },
    { id: "kota-kinabalu", label: "Kota Kinabalu" },
  ],
};

/** Cities for a country, or [] when we don't have a list (type-it-yourself). */
export function getCitiesForCountry(countryId: string): readonly Option[] {
  return CITIES_BY_COUNTRY[countryId] ?? [];
}
