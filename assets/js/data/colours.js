/*
 * Official Cascadia Metals colour collections.
 *
 * Names and collection membership follow the Cascadia Metals Classic (SMP) and
 * Signature (PVDF) colour cards. Hex values are on-screen approximations used
 * for the configurator preview only -- printed and screen renderings never match
 * a physical chip. Always confirm against a real metal sample before ordering.
 */
window.CM = window.CM || {};

CM.families = [
  { id: 'all', label: 'All Colours' },
  { id: 'white', label: 'White' },
  { id: 'grey', label: 'Grey' },
  { id: 'black', label: 'Black' },
  { id: 'brown', label: 'Brown' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'red', label: 'Red' },
  { id: 'metallic', label: 'Metallic' }
];

CM.collections = {
  smp: {
    id: 'smp',
    name: 'Classic SMP Colour Collection',
    tagline: 'Silicone-modified polyester over G90 galvanized or Galvalume substrate.',
    disclaimer:
      'Classic SMP colours shown are on-screen approximations of the Cascadia Metals Classic collection. ' +
      'Some colours are regional or mill-order only. Request a physical chip before final selection.',
    colours: [
      { name: 'White-White',      hex: '#FAFAF8', family: 'white' },
      { name: 'Bright White',     hex: '#F3F3EF', family: 'white' },
      { name: 'Appliance White',  hex: '#F1EFE9', family: 'white' },
      { name: 'Polar White',      hex: '#EAE9E0', family: 'white' },
      { name: 'Surf White',       hex: '#E4E5E0', family: 'white' },
      { name: 'Cambridge White',  hex: '#E7E5DB', family: 'white' },
      { name: 'Bone White',       hex: '#E8E1D1', family: 'white' },
      { name: 'Cashmere',         hex: '#DCD3BE', family: 'brown' },
      { name: 'Antique Linen',    hex: '#D8CCB3', family: 'brown' },
      { name: 'Wicker',           hex: '#C8B795', family: 'brown' },
      { name: 'Tan',              hex: '#C0AB84', family: 'brown' },
      { name: 'Briarwood Tan',    hex: '#A88E6A', family: 'brown' },
      { name: 'Buckskin',         hex: '#9B7E57', family: 'brown', note: 'ON / QC availability' },
      { name: 'Gold',             hex: '#C29A4A', family: 'brown' },
      { name: 'Pebblestone',      hex: '#B2ACA0', family: 'grey' },
      { name: 'Stone Grey',       hex: '#A2A5A2', family: 'grey' },
      { name: 'Regent Grey',      hex: '#898E91', family: 'grey' },
      { name: 'Charcoal',         hex: '#494D51', family: 'grey' },
      { name: 'Iron Ore',         hex: '#59534F', family: 'grey' },
      { name: 'Dark Graphite',    hex: '#3D4144', family: 'grey', note: 'ON / QC availability' },
      { name: 'Black',            hex: '#212223', family: 'black' },
      { name: 'Metro Brown',      hex: '#6A5445', family: 'brown' },
      { name: 'Coffee Brown',     hex: '#49372B', family: 'brown' },
      { name: 'Dark Brown',       hex: '#392B22', family: 'brown' },
      { name: 'Mist Green',       hex: '#B8C3B3', family: 'green' },
      { name: 'Sage Green',       hex: '#8D9B81', family: 'green' },
      { name: 'Deep Water Green', hex: '#3E5D55', family: 'green' },
      { name: 'Forest Green',     hex: '#2E4937', family: 'green' },
      { name: 'Spruce Green',     hex: '#284439', family: 'green' },
      { name: 'Melchers Green',   hex: '#1E3C2D', family: 'green' },
      { name: 'Dark Green',       hex: '#1A3326', family: 'green' },
      { name: 'Turquoise',        hex: '#4D999A', family: 'blue' },
      { name: 'Pacific Turquoise',hex: '#3B8B92', family: 'blue' },
      { name: 'Labrador Blue',    hex: '#324F79', family: 'blue' },
      { name: 'Royal Blue',       hex: '#294A8C', family: 'blue' },
      { name: 'Bright Red',       hex: '#B32229', family: 'red' },
      { name: 'Tile Red',         hex: '#9D3A2D', family: 'red' },
      { name: 'Dark Red',         hex: '#7B2125', family: 'red' },
      { name: 'Burgundy',         hex: '#5D1E29', family: 'red' }
    ]
  },

  pvdf: {
    id: 'pvdf',
    name: 'Signature PVDF Colour Collection',
    tagline: '70% PVDF (Kynar 500 / Hylar 5000 class) architectural coating.',
    disclaimer:
      'Signature PVDF colours shown are on-screen approximations of the Cascadia Metals Signature collection. ' +
      'Metallic colours are batch-sensitive and directional -- order all material for one elevation from a single batch.',
    colours: [
      { name: 'Regal White',        hex: '#EFEEE8', family: 'white' },
      { name: 'Parchment',          hex: '#DFD8C5', family: 'white' },
      { name: 'Sierra Tan',         hex: '#BFAD92', family: 'brown' },
      { name: 'Champagne Metallic', hex: '#C6B69B', family: 'metallic', metallic: true },
      { name: 'Mocha',              hex: '#796653', family: 'brown' },
      { name: 'Weathered Copper',   hex: '#956949', family: 'metallic', metallic: true },
      { name: 'Bronze',             hex: '#6A5A4A', family: 'brown' },
      { name: 'Dark Bronze',        hex: '#3F342B', family: 'brown' },
      { name: 'Copper Penny',       hex: '#AF7149', family: 'metallic', metallic: true },
      { name: 'Terra Cotta',        hex: '#A7553B', family: 'red' },
      { name: 'Colonial Red',       hex: '#8D2A2A', family: 'red' },
      { name: 'Retro Red',          hex: '#A22429', family: 'red' },
      { name: 'Hemlock Green',      hex: '#4B5E49', family: 'green' },
      { name: 'Forest Green',       hex: '#2B4535', family: 'green' },
      { name: 'Hartford Green',     hex: '#233F2E', family: 'green' },
      { name: 'Twilight Blue',      hex: '#2E4255', family: 'blue' },
      { name: 'Regal Blue',         hex: '#1E3B62', family: 'blue' },
      { name: 'Silver Metallic',    hex: '#A8ADB1', family: 'metallic', metallic: true },
      { name: 'Old Town Grey',      hex: '#999A95', family: 'grey' },
      { name: 'Weathered Zinc',     hex: '#7D837F', family: 'metallic', metallic: true },
      { name: 'Old Zinc Grey',      hex: '#6D726F', family: 'grey' },
      { name: 'Slate Grey',         hex: '#4E5559', family: 'grey' },
      { name: 'Black',              hex: '#222325', family: 'black' }
    ]
  },

  aluminum: {
    id: 'aluminum',
    name: 'PVDF Aluminum Colour Collection',
    tagline: 'PVDF-coated aluminum -- stocked colours plus the full Signature range by mill order.',
    disclaimer:
      'Polar White, Charcoal and Weathered Zinc are the regularly stocked PVDF aluminum colours. ' +
      'The balance of the Signature PVDF range is available on aluminum by mill order, subject to minimum quantities.',
    colours: [
      { name: 'Polar White',        hex: '#EAE9E0', family: 'white',    stocked: true },
      { name: 'Charcoal',           hex: '#494D51', family: 'grey',     stocked: true },
      { name: 'Weathered Zinc',     hex: '#7D837F', family: 'metallic', metallic: true, stocked: true },
      { name: 'Regal White',        hex: '#EFEEE8', family: 'white' },
      { name: 'Parchment',          hex: '#DFD8C5', family: 'white' },
      { name: 'Sierra Tan',         hex: '#BFAD92', family: 'brown' },
      { name: 'Champagne Metallic', hex: '#C6B69B', family: 'metallic', metallic: true },
      { name: 'Mocha',              hex: '#796653', family: 'brown' },
      { name: 'Bronze',             hex: '#6A5A4A', family: 'brown' },
      { name: 'Dark Bronze',        hex: '#3F342B', family: 'brown' },
      { name: 'Copper Penny',       hex: '#AF7149', family: 'metallic', metallic: true },
      { name: 'Terra Cotta',        hex: '#A7553B', family: 'red' },
      { name: 'Colonial Red',       hex: '#8D2A2A', family: 'red' },
      { name: 'Hemlock Green',      hex: '#4B5E49', family: 'green' },
      { name: 'Hartford Green',     hex: '#233F2E', family: 'green' },
      { name: 'Twilight Blue',      hex: '#2E4255', family: 'blue' },
      { name: 'Regal Blue',         hex: '#1E3B62', family: 'blue' },
      { name: 'Silver Metallic',    hex: '#A8ADB1', family: 'metallic', metallic: true },
      { name: 'Slate Grey',         hex: '#4E5559', family: 'grey' },
      { name: 'Black',              hex: '#222325', family: 'black' }
    ]
  },

  copper: {
    id: 'copper',
    name: 'Copper Finishes',
    tagline: 'Uncoated architectural copper -- a living finish that changes on the building.',
    disclaimer:
      'Copper is supplied mill-finish or pre-patinated. Natural copper will continue to weather in service; ' +
      'the patina stages shown are illustrative and vary with climate, orientation and rainfall.',
    colours: [
      { name: 'Natural Copper',    hex: '#B87036', family: 'metallic', metallic: true },
      { name: 'Statuary Bronze',   hex: '#6E4B32', family: 'metallic', metallic: true },
      { name: 'Weathered Copper',  hex: '#4F4033', family: 'metallic', metallic: true },
      { name: 'Pre-Patina Green',  hex: '#5C9C82', family: 'green',    metallic: true }
    ]
  },

  zinc: {
    id: 'zinc',
    name: 'Architectural Zinc Finishes',
    tagline: 'Rolled zinc-copper-titanium alloy -- natural and pre-weathered surfaces.',
    disclaimer:
      'Zinc surfaces develop a protective patina in service. Natural zinc arrives bright and dulls over the first ' +
      'one to three years; pre-weathered finishes arrive at their final tone.',
    colours: [
      { name: 'Natural Zinc',        hex: '#A9AEAB', family: 'metallic', metallic: true },
      { name: 'Pre-weathered Zinc',  hex: '#7D837F', family: 'metallic', metallic: true },
      { name: 'Quartz Zinc',         hex: '#8C918D', family: 'metallic', metallic: true },
      { name: 'Anthra Zinc',         hex: '#3C4043', family: 'metallic', metallic: true }
    ]
  }
};

/* Copper patina timeline -- used by the animated weathering strip. */
CM.patinaTimeline = [
  {
    stage: 'Day 1',
    hex: '#C4783C',
    accent: '#E4A063',
    title: 'Mill Bright',
    body: 'Fresh copper leaves the brake with a bright salmon-pink lustre and a mirror-like specular highlight. ' +
          'Handling marks and fingerprints are visible at this stage and will disappear as the surface oxidizes.'
  },
  {
    stage: '6 Months',
    hex: '#8E5836',
    accent: '#B0754A',
    title: 'Russet Oxide',
    body: 'A cuprous oxide film forms and the surface darkens to a warm russet brown. Gloss drops sharply. ' +
          'Weathering is uneven at first -- sheltered faces under a chimney crown lag behind exposed ones.'
  },
  {
    stage: '2 Years',
    hex: '#5B4132',
    accent: '#77543F',
    title: 'Chocolate Brown',
    body: 'The oxide layer thickens into a deep chocolate brown. The finish is now matte and uniform across ' +
          'the elevation. This is the stage most homeowners see for the longest stretch of the cap\'s life.'
  },
  {
    stage: '5 Years',
    hex: '#4C5A48',
    accent: '#6B7C60',
    title: 'Patina Onset',
    body: 'Sulphate salts begin to form. Green mottling appears first along water paths -- drip edges, standing ' +
          'seam ribs and the underside of hemmed returns -- against the remaining brown ground.'
  },
  {
    stage: '10 Years',
    hex: '#4F8E76',
    accent: '#72AC93',
    title: 'Verdigris',
    body: 'A continuous copper-sulphate patina covers the surface. The green layer is chemically bonded, ' +
          'self-renewing and protects the copper beneath it -- the reason copper roofs measure life in centuries.'
  }
];

/* Zinc finish detail -- used by the zinc panel. */
CM.zincFinishes = [
  {
    name: 'Natural Zinc',
    hex: '#A9AEAB',
    sheen: 0.85,
    grain: 'fine',
    body: 'Mill-bright rolled zinc with a reflective, slightly blue-grey surface. Weathers naturally on the ' +
          'building to a soft matte grey over one to three years depending on exposure.'
  },
  {
    name: 'Pre-weathered Zinc',
    hex: '#7D837F',
    sheen: 0.35,
    grain: 'matte',
    body: 'Chemically pre-patinated at the mill to the tone natural zinc reaches after years of weathering. ' +
          'Arrives uniform, so elevations match from day one with no waiting period.'
  },
  {
    name: 'Quartz Zinc',
    hex: '#8C918D',
    sheen: 0.45,
    grain: 'fine',
    body: 'A light pre-weathered grey with a faint warm cast. The most common architectural zinc for ' +
          'residential standing seam, wall cladding and chimney surrounds.'
  },
  {
    name: 'Anthra Zinc',
    hex: '#3C4043',
    sheen: 0.30,
    grain: 'matte',
    body: 'Deep anthracite pre-weathered zinc. Reads nearly black at distance with visible grey structure ' +
          'up close. Pairs with dark-framed glazing and contemporary detailing.'
  }
];
