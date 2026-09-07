// Reviewed Cob & Pip source wording corrections. Every alias is scoped to one
// reviewed retailer collection AND one collector number. These are not fuzzy
// rules and must never be promoted to global card-name normalization.
//
// Deliberately excluded examples:
// - 151 #030 `Nidoqueen` vs canonical `Nidorina`
// - Ascended Heroes #204 `Team Rocket's Great Ball` vs canonical `Team Rocket's Giovanni`
// - Prismatic Evolutions #108 `Festival Guidance` vs canonical `Festival Grounds`
// Those are materially different names and remain quarantined.
export const COB_PIP_REVIEWED_CARD_NAME_ALIASES = Object.freeze({
  'pokemon-pitch-black': Object.freeze({
    '55': Object.freeze({ Morpeko: 'Morpeko ex' }),
    '60': Object.freeze({ Skarmony: 'Skarmory' }),
    '112': Object.freeze({ 'Rust Syndicate Grunt -': 'Rust Syndicate Grunt' }),
  }),
  'pokemon-perfect-order': Object.freeze({
    '17': Object.freeze({ Turnonator: 'Turtonator' }),
    '35': Object.freeze({ Spirtzee: 'Spritzee' }),
    '80': Object.freeze({ Pokeball: 'Poké Ball' }),
    '82': Object.freeze({ 'Pokemon Catcher': 'Pokémon Catcher' }),
    '86': Object.freeze({ 'Growing Energy': 'Growing Grass Energy' }),
    '87': Object.freeze({ 'Rocky Energy': 'Rocky Fighting Energy' }),
    '88': Object.freeze({ 'Telepathic Energy': 'Telepathic Psychic Energy' }),
    '120': Object.freeze({ 'Mega Zygarde': 'Mega Zygarde ex' }),
  }),
  'pokemon-ascended-heroes': Object.freeze({
    '6': Object.freeze({ "Eria's Victreebel": "Erika's Victreebel" }),
    '9': Object.freeze({ Bayleaf: 'Bayleef' }),
    '181': Object.freeze({ 'Air Ballon': 'Air Balloon' }),
  }),
  'pokemon-phantasmal-flames': Object.freeze({
    '4': Object.freeze({ 'Mega Herracross EX': 'Mega Heracross ex' }),
    '81': Object.freeze({ Zigazagoon: 'Zigzagoon' }),
  }),
  'pokemon-mega-evolution': Object.freeze({
    '25': Object.freeze({ Volcaion: 'Volcanion' }),
    '60': Object.freeze({ 'Mega Gardevoir EX #060': 'Mega Gardevoir ex' }),
  }),
  'pokemon-prismatic-evolutions': Object.freeze({
    '8': Object.freeze({ Whimscott: 'Whimsicott' }),
    '10': Object.freeze({ Diplin: 'Dipplin' }),
    '40': Object.freeze({ Slyveon: 'Sylveon' }),
    '42': Object.freeze({ 'Scream Tails': 'Scream Tail' }),
    '53': Object.freeze({ Hippodon: 'Hippowdon' }),
    '69': Object.freeze({ Duraudon: 'Duraludon' }),
    '94': Object.freeze({ 'Aero Zero Underdepths': 'Area Zero Underdepths' }),
    '96': Object.freeze({ 'Black Belts Training': "Black Belt's Training" }),
    '97': Object.freeze({ 'Black Belts Training': "Black Belt's Training" }),
    '98': Object.freeze({ 'Black Belts Training': "Black Belt's Training" }),
    '99': Object.freeze({ 'Black Belts Training': "Black Belt's Training" }),
    '101': Object.freeze({ 'Buddy Buddy Poffin': 'Buddy-Buddy Poffin' }),
    '107': Object.freeze({ 'Explorers Guidance': "Explorer's Guidance" }),
    '112': Object.freeze({ 'Janine Secret Art': "Janine's Secret Art" }),
    '122': Object.freeze({ "Professor's Reasearch OAK": "Professor's Research" }),
    '123': Object.freeze({ "Professor's Reasearch ELM": "Professor's Research" }),
    '124': Object.freeze({ "Professor's Reasearch ROWAN": "Professor's Research" }),
    '125': Object.freeze({ "Professor's Reasearch SYCAMORE": "Professor's Research" }),
    '127': Object.freeze({ 'Roto Stick': 'Roto-Stick' }),
  }),
  'pokemon-surging-sparks': Object.freeze({
    '9': Object.freeze({ Shinnotic: 'Shiinotic' }),
    '12': Object.freeze({ CaspaKid: 'Capsakid' }),
    '27': Object.freeze({ Sizzlepede: 'Sizzlipede' }),
    '29': Object.freeze({ Furecoco: 'Fuecoco' }),
    '56': Object.freeze({ 'Chien-Po': 'Chien-Pao' }),
    '65': Object.freeze({ 'Tapu Kolo': 'Tapu Koko' }),
    '121': Object.freeze({ Grafarai: 'Grafaiai' }),
    '157': Object.freeze({ Tandermaus: 'Tandemaus' }),
    '162': Object.freeze({ 'ACESPEC Amulet of Hope': 'Amulet of Hope' }),
    '172': Object.freeze({ 'Dragon Elixar': 'Dragon Elixir' }),
    '176': Object.freeze({ 'ACESPEC Energy Search Pro': 'Energy Search Pro' }),
    '181': Object.freeze({ 'Medding Memo': 'Meddling Memo' }),
    '186': Object.freeze({ 'ACESPEC Scramble Switch': 'Scramble Switch' }),
  }),
  'pokemon-twilight-masquerade': Object.freeze({
    '86': Object.freeze({ Flabebe: 'Flabébé' }),
    '162': Object.freeze({ 'ACESPEC Scoop Up Cyclone': 'Scoop Up Cyclone' }),
  }),
  'pokemon-temporal-forces': Object.freeze({
    '29': Object.freeze({ Marcargo: 'Magcargo' }),
    '63': Object.freeze({ 'Mr Mime': 'Mr. Mime' }),
    '154': Object.freeze({ 'Maximum Belt Acespec': 'Maximum Belt' }),
    '158': Object.freeze({ 'ACESPEC RebootPod': 'Reboot Pod' }),
    '201': Object.freeze({ 'Morty Conviction': "Morty's Conviction" }),
  }),
  'pokemon-obsidian-flames': Object.freeze({
    '20': Object.freeze({ Doliv: 'Dolliv' }),
    '173': Object.freeze({ Audio: 'Audino' }),
  }),
});

export function reviewedCobPipCardNameAlias(bindingKey, collectorNumber, sourceName) {
  const aliases = COB_PIP_REVIEWED_CARD_NAME_ALIASES[String(bindingKey || '')]?.[String(collectorNumber || '')] || {};
  const target = Object.entries(aliases).find(([source]) => source.localeCompare(String(sourceName || ''), undefined, { sensitivity: 'accent' }) === 0)?.[1];
  return target || null;
}
