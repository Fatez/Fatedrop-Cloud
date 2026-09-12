import { createHash } from 'node:crypto';

export const REVIEWED_STALE_VARIANT_TCGDEX_REVISION = '5b6a2859f454972477a9953ffe5cb554d24c45e9';
export const REVIEWED_STALE_VARIANT_PLAN_DIGEST = 'eeb727f7368f1745b8174b619736b01def2aa1f0c6f1b4bf520a6a45ff4246af';
export const REVIEWED_BASELINE_HOLO_PRODUCT_IDS = Object.freeze(`567125,567126,574064,574065,658696,665266,682075,725122,725244,740733,760642,769214,769238,769308,780902,785852,785883,785895,785959,786003,794314,794373,794503,805395,805403,805412,805415,805419,805423,805430,805449,805453,805465,805474,817176,817182,817221,817266,817320,851204,869697,869766`.split(','));

const RAW = `
competing_normal|fdcardmap_1ca918c9573333436dafce21|fdcard_91935c83cbb97e4cbe93b779|760792|normal|sv05-162||760792|fdcardmap_349a3e6d4f04a8709584e087
competing_normal|fdcardmap_37b5617121cc48a802b034cb|fdcard_043a2f0fc48bc2f9afaf7be5|568801|normal|swshp-SWSH129||568801|fdcardmap_86c212a945706eedccad3e7f
stamped_holo|fdcardmap_03e0bb5e3265fc0356baa4a7|fdcard_7d736f1b800dd049ae69ec7b|845407|holo|sv07-149|snowflake|786003|fdcardmap_a8023347130658c8da4dfb0d
stamped_holo|fdcardmap_050c60a6309657a84f4b7adc|fdcard_62a6fe4a92d39f0179208524|855660|holo|sv09-069|set-logo|817221|fdcardmap_4fee8019629226c190c5bbff
stamped_holo|fdcardmap_0860ee6e5704e6df21a24837|fdcard_1ff7e011f27b4585cd3d70f8|810430|holo|sv08.5-075|set-logo|805465|fdcardmap_ff7c166411fd327bc9942f3c
stamped_holo|fdcardmap_0935319968a99a03a7877d29|fdcard_e875e0ea08101293778a7794|841276|holo|sv08-130|set-logo|794503|fdcardmap_e1be321a93da6f9312ed860a
stamped_holo|fdcardmap_0afd345fed47c2e7ec078823|fdcard_cedf87a4f759d8c4a2d29201|851067|holo|me01-133|set-logo|851204|fdcardmap_7cd0890511225168b6431be6
stamped_holo|fdcardmap_113347d0c022e17dc62cf8b7|fdcard_92420f58aa5bf485f7ac58cf|845410|holo|sv08.5-026|snowflake|805415|fdcardmap_add17a3f05b362bf3bdfc0ab
stamped_holo|fdcardmap_12ced1c1b3049650e020009b|fdcard_08129fdd659788430c6d91f5|780007|holo|sv03-164|gym-challenge|725244|fdcardmap_5c0af387dfb8025f7f5ef94d
stamped_holo|fdcardmap_1707d64628e5250a93083dbc|fdcard_081adb202d555b879a41c238|841260|holo|sv06.5-012|set-logo|780902|fdcardmap_0ccd53bcd1749eec6f8bc81c
stamped_holo|fdcardmap_18177cedd3585e9899746c1c|fdcard_e0e75e6b16c7830ae86802ad|841266|holo|sv07-105|set-logo|785959|fdcardmap_036bf5090f7982ccd22fc9ee
stamped_holo|fdcardmap_1cb41eaa09f2b3973f9e1fdd|fdcard_a4afad4b2f09622b9c5a4059|785464|holo|sv03-042|snowflake|725122|fdcardmap_8c88e0047498f011c58bd5fa
stamped_holo|fdcardmap_1d7783628c9e6671e7e6dda7|fdcard_f519a07734a521968740cd2e|740473|holo|swsh12-033|snowflake|682075|fdcardmap_9baa3344cd19a99c46afcde5
stamped_holo|fdcardmap_20266c9ea3f3a60ed2dfbbbe|fdcard_c5b29d3e3055d592e4aebf49|810424|holo|sv08.5-023|set-logo|805412|fdcardmap_3b2fdf9647c3b354b832bf59
stamped_holo|fdcardmap_25962c20ef3d7cb7231dfd1f|fdcard_857e5843eaab4396ae87409a|841259|holo|sv06-134|set-logo|769308|fdcardmap_d430b7f0b020ba5c2c542a5c
stamped_holo|fdcardmap_280480b141fba9a2c0c8d8e0|fdcard_3c7411d7b0fe2625131e1979|841264|holo|sv07-030|set-logo|785883|fdcardmap_ed13f1d5bf274431d9bbb24f
stamped_holo|fdcardmap_2d4afdf2c276ff96d55851da|fdcard_adec52f6cb12339d56c7e555|672377|holo|swsh6-45|snowflake|567125|fdcardmap_4d40891ab0d41c089a36a47f
stamped_holo|fdcardmap_2f6d90c11c64245c5dc3d2a2|fdcard_65468b4eaa68ca7cd442fa96|740475|holo|swsh7-41|snowflake|574065|fdcardmap_ed5b2e771cace89860e3fe08
stamped_holo|fdcardmap_37146615dd2dfe82b77d5ccd|fdcard_e0e75e6b16c7830ae86802ad|841267|holo|sv07-105|set-logo|785959|fdcardmap_036bf5090f7982ccd22fc9ee
stamped_holo|fdcardmap_43567c0fe105dbb6c5a2b59a|fdcard_fe0a12e079698c49ae4c9a88|841274|holo|sv08-076|set-logo|794373|fdcardmap_5f668865ece54d5fc9ad81e0
stamped_holo|fdcardmap_446340412899770f25000873|fdcard_722d99ddbaaa8c4ff508fcaa|894178|holo|me02.5-155|pokemon-center|869766|fdcardmap_c4b896fcccfb8ffb3e50357b
stamped_holo|fdcardmap_4ba4bf1db903d46d5d9949b7|fdcard_36d48b34cedb68a115d8366e|841262|holo|sv07-001|set-logo|785852|fdcardmap_07e12b83ef980b947054944c
stamped_holo|fdcardmap_5081f185479f6b567feb8dd5|fdcard_399682c17f0ba04af04f02bb|841270|holo|sv07-041|set-logo|785895|fdcardmap_b0e2c6868f0952e6281f5219
stamped_holo|fdcardmap_55216ff29d3219ca66063064|fdcard_48b15cd932187842ffacca61|845428|holo|sv08.5-064|set-logo|805453|fdcardmap_e49628a114fe0dc5fb5e6bf3
stamped_holo|fdcardmap_5ef8a07421dd44db598c2f4d|fdcard_54443ed9fdc7963d14e0368c|853515|holo|sv09-114|set-logo|817266|fdcardmap_b0c9502b77b86d830d1a4541
stamped_holo|fdcardmap_5fe77e4e65eec9908a11eacc|fdcard_1c6efeb2c0dc8e0096905d5f|672378|holo|swsh6-46|snowflake|567126|fdcardmap_242b0fde4230858e65f340ae
stamped_holo|fdcardmap_609acc03d2fa22ddbc73e215|fdcard_08129fdd659788430c6d91f5|811161|holo|sv03-164|player-rewards-program|725244|fdcardmap_5c0af387dfb8025f7f5ef94d
stamped_holo|fdcardmap_71592283fa31871ce8d32c07|fdcard_a5056ebf73833f6c54a22881|868293|holo|sv08.5-082|set-logo|805474|fdcardmap_0dee1b2264190372d5933fa3
stamped_holo|fdcardmap_768595da8d397d60c1e64718|fdcard_c70d4d40bf831e0dde439ca2|817768|holo|sv09-167|set-logo|817320|fdcardmap_4979870a745de225b9a4b893
stamped_holo|fdcardmap_7d78489e77655d32c7bcbb1b|fdcard_63e203ec9ce37cc3821eb09f|841272|holo|sv08-048|set-logo|794314|fdcardmap_026b34444a7b1f9755be76a8
stamped_holo|fdcardmap_8280a3c316bd8a568e3c2f62|fdcard_63e203ec9ce37cc3821eb09f|841271|holo|sv08-048|set-logo|794314|fdcardmap_026b34444a7b1f9755be76a8
stamped_holo|fdcardmap_82e406721c4c0174e8a2c2a8|fdcard_69966eff1b5e26e1e7936880|830114|holo|sv06-064|set-logo|769238|fdcardmap_06341c2ee9abe8dbdf0cc72a
stamped_holo|fdcardmap_8365b036f8609420b8850c72|fdcard_3e1d51147ac93d1bf8b02ec8|830112|holo|sv06-040|set-logo|769214|fdcardmap_973e5d4a1e4920bb6d70d8be
stamped_holo|fdcardmap_8eee893b9df46a5243d3352a|fdcard_edae92e65e2d789a7f002d1f|894173|holo|me02.5-086|pokemon-center|869697|fdcardmap_d2836aa7493a441005caff57
stamped_holo|fdcardmap_8f1a955cef5875e6e61d45b8|fdcard_b51d636a055cfce85ce9ecfd|841284|holo|sv09-024|set-logo|817176|fdcardmap_7274a931a562335f95a4da60
stamped_holo|fdcardmap_8fcec58369c82d2a13f1c89b|fdcard_a5056ebf73833f6c54a22881|868296|holo|sv08.5-082|set-logo|805474|fdcardmap_0dee1b2264190372d5933fa3
stamped_holo|fdcardmap_946e6f2a679c6695d98ad2df|fdcard_eb1d458388a7feca11175fe6|810429|holo|sv08.5-060|set-logo|805449|fdcardmap_3ea51dfefdc64414fa964f86
stamped_holo|fdcardmap_95f90eb4a171e461bb40b7fd|fdcard_3e1d51147ac93d1bf8b02ec8|830113|holo|sv06-040|set-logo|769214|fdcardmap_973e5d4a1e4920bb6d70d8be
stamped_holo|fdcardmap_9d4911304639dbc370f3a70b|fdcard_771a0e38305d6f9c65396803|810428|holo|sv08.5-041|set-logo|805430|fdcardmap_d078347710c31c8a656014de
stamped_holo|fdcardmap_9e97e1c138156e0e39da6afc|fdcard_2c9d7be25f8a66511047e2f0|810422|holo|sv08.5-006|set-logo|805395|fdcardmap_469afb26c0c261995b68ee8a
stamped_holo|fdcardmap_a085f2b2d8335bcbff361d54|fdcard_710aef2d9f251834c0eee131|810423|holo|sv08.5-014|set-logo|805403|fdcardmap_2d4b25b50634c985b5fb0bc2
stamped_holo|fdcardmap_b5a46a34b68f38a6f5b5f494|fdcard_bb8f7906e50df27661fdb291|845406|holo|sv04-190|snowflake|740733|fdcardmap_b0f12e2a1b7c3db9cea2d3b2
stamped_holo|fdcardmap_bd6fa6d5319cf68f0c360071|fdcard_36d48b34cedb68a115d8366e|841261|holo|sv07-001|set-logo|785852|fdcardmap_07e12b83ef980b947054944c
stamped_holo|fdcardmap_c0f58f06dfdcc800be47a7ca|fdcard_54443ed9fdc7963d14e0368c|853517|holo|sv09-114|set-logo|817266|fdcardmap_b0c9502b77b86d830d1a4541
stamped_holo|fdcardmap_c45ff9d21c4a6440389b2e9d|fdcard_cdcc882abeeea37cad0f3789|810426|holo|sv08.5-030|set-logo|805419|fdcardmap_04f0ac50687e77f8038fccc2
stamped_holo|fdcardmap_ccbc4d9d3f35540280d5b77a|fdcard_92420f58aa5bf485f7ac58cf|810425|holo|sv08.5-026|set-logo|805415|fdcardmap_add17a3f05b362bf3bdfc0ab
stamped_holo|fdcardmap_cddb67df50b3d6ff75f268db|fdcard_c01ccab5a1608b900ffdde87|841283|holo|sv09-030|set-logo|817182|fdcardmap_3d1dfba0b82867423094edea
stamped_holo|fdcardmap_d988af9d3547637b340198fd|fdcard_fe0a12e079698c49ae4c9a88|841273|holo|sv08-076|set-logo|794373|fdcardmap_5f668865ece54d5fc9ad81e0
stamped_holo|fdcardmap_d9faaecf49eeb4d10be4aff0|fdcard_04f06ffda69f2fbdd0570abf|728200|holo|swsh10.5-030|player-rewards-program|665266|fdcardmap_b1d049cda7c15cb85714bf98
stamped_holo|fdcardmap_dd92f779c77de5311443f57c|fdcard_9ea8ff18394a616370d3691f|664803|holo|swsh10-084|set-logo|658696|fdcardmap_09b2aed995afba0cb3364a6d
stamped_holo|fdcardmap_ddbc4abadae6967d9c615201|fdcard_58856a0edf60e8510b5f2a16|865202|holo|sv05-012|set-logo|760642|fdcardmap_309c4251e135dbcc5be5faee
stamped_holo|fdcardmap_f09c6633412064e3858bcfa3|fdcard_62a6fe4a92d39f0179208524|855661|holo|sv09-069|set-logo|817221|fdcardmap_4fee8019629226c190c5bbff
stamped_holo|fdcardmap_f51d30c177002ec29f858cd1|fdcard_633b51df822f89699654d2d3|740474|holo|swsh7-40|snowflake|574064|fdcardmap_87ce7a4511d0d3dae539880a
stamped_holo|fdcardmap_f5376579fb4702ae6cc95eef|fdcard_08129fdd659788430c6d91f5|819255|holo|sv03-164|asia-promo|725244|fdcardmap_5c0af387dfb8025f7f5ef94d
stamped_holo|fdcardmap_f6ea43817fcef555ee249420|fdcard_e875e0ea08101293778a7794|841277|holo|sv08-130|set-logo|794503|fdcardmap_e1be321a93da6f9312ed860a
stamped_holo|fdcardmap_f859b7f81e6740cbcbd39e47|fdcard_399682c17f0ba04af04f02bb|841269|holo|sv07-041|set-logo|785895|fdcardmap_b0e2c6868f0952e6281f5219
stamped_holo|fdcardmap_f86f8e44c65f00a420dfe134|fdcard_c01ccab5a1608b900ffdde87|841282|holo|sv09-030|set-logo|817182|fdcardmap_3d1dfba0b82867423094edea
stamped_holo|fdcardmap_fc16745ef417d1e0a48f5f18|fdcard_5410c930dd8c5dff6eaadeb2|810427|holo|sv08.5-034|set-logo|805423|fdcardmap_fc8b900b86118fb23064edaf
`.trim();
const FIELDS = ["kind", "mappingId", "cardIdentityId", "sourceRecordId", "sourceVariantKey", "tcgdexCardId", "stamp", "retainedProductId", "retainedMappingId"];
export const REVIEWED_STALE_VARIANT_RETIREMENTS = Object.freeze(RAW.split('\n').map((line) => Object.freeze(Object.fromEntries(line.split('|').map((value, index) => [FIELDS[index], value])))));

export function reviewedStaleVariantPlanDigest(rows = REVIEWED_STALE_VARIANT_RETIREMENTS) {
  const canonical = [...rows]
    .sort((a,b) => `${a.kind}|${a.mappingId}`.localeCompare(`${b.kind}|${b.mappingId}`))
    .map((row) => FIELDS.map((field) => row[field] ?? '').join('|')).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export function validateReviewedStaleVariantPlan() {
  if (REVIEWED_STALE_VARIANT_RETIREMENTS.length !== 58) return false;
  if (new Set(REVIEWED_STALE_VARIANT_RETIREMENTS.map((row) => row.mappingId)).size !== 58) return false;
  if (REVIEWED_STALE_VARIANT_RETIREMENTS.filter((row) => row.kind === 'stamped_holo').length !== 56) return false;
  if (REVIEWED_STALE_VARIANT_RETIREMENTS.filter((row) => row.kind === 'competing_normal').length !== 2) return false;
  if (new Set(REVIEWED_BASELINE_HOLO_PRODUCT_IDS).size !== 42) return false;
  if (REVIEWED_STALE_VARIANT_RETIREMENTS.some((row) => row.kind === 'stamped_holo' && (!row.stamp || row.sourceVariantKey !== 'holo'))) return false;
  if (REVIEWED_STALE_VARIANT_RETIREMENTS.some((row) => row.kind === 'competing_normal' && (row.stamp || row.sourceVariantKey !== 'normal' || row.sourceRecordId !== row.retainedProductId))) return false;
  return reviewedStaleVariantPlanDigest() === REVIEWED_STALE_VARIANT_PLAN_DIGEST;
}
