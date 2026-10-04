/** Authored synthetic rules for workspace contracts, not extracted game content.
 * Six distinct characters, uniform growth curves, and two linear instruments
 * exercise validation/import boundaries without a generated content snapshot.
 */
export function createSharedTeamRules() {
  const rates = {_performanceRate:10000, _technicRate:10000, _visualRate:10000};
  const sequence = (length, make) => Array.from({length}, (_, index) => make(index + 1));
  return {schemaVersion:1, sourceReleaseId:'synthetic-shared-team-v1', ruleSetVersion:'synthetic-formation-v1',
    verificationStatus:'code_audited', tables:{
      MemberCard:sequence(6, id => ({_id:id, _characterID:id, _rarity:4, _cardType:1, _bestMusicTagIDs:[],
        _memberCardRankGroup:1, _memberCardLevelGroup:1, _memberCardAwakeGroup:1,
        _leaderSkillID:1, _liveSkillID:1, _gekisouSkillID:1,
        _performancePowerMax:100, _technicPowerMax:100, _visualPowerMax:100})),
      SupportCard:sequence(6, id => ({_id:id, _characterIDs:[id], _rarity:4, _cardType:1,
        _supportCardRankGroup:1, _supportCardLevelGroup:1,
        _performancePowerMax:100, _technicPowerMax:100, _visualPowerMax:100})),
      Character:sequence(6, id => ({_id:id, _bandID:1})),
      MemberCardRank:sequence(5, rank => ({_group:1, _rank:rank, _leaderSkillLevel:1,
        _musicTypeBonusRate:0, _musicTagBonusRate:0, ...rates})),
      SupportCardRank:sequence(5, rank => ({_group:1, _rank:rank, _limitLevel:20 + rank * 10,
        _cardTypeLinkBonusRate:0, ...rates})),
      MemberCardAwake:sequence(5, awake => ({_group:1, _awakeCount:awake, ...rates})),
      MemberCardLevelLimit:sequence(5, awake => ({_rarity:4, _awakeCount:awake, _limitLevel:20 + awake * 10})),
      MemberCardLevel:sequence(70, level => ({_group:1, _level:level, _exp:(level - 1) * 70, ...rates})),
      SupportCardLevel:sequence(70, level => ({_group:1, _level:level, _exp:(level - 1) * 70, ...rates})),
      CharacterRank:sequence(50, rank => ({_rank:rank, _exp:rank === 1 ? 0 : 1 + (rank - 2) * 100, _bonus:rank - 1})),
      CharacterTotalRank:[{_totalRank:0, _bonus:0}],
      SkillTarget:[], LiveSkill:[{_id:1, _skillCategories:[]}], GekisouSkill:[{_id:1, _gekisouMissionType:1}],
      LeaderSkillEffect:[{_leaderSkillID:1, _level:1, _skillEffectType:1000, _skillTargetIDs:[], _effectValue:0}],
      Parameter:['type_link_base_bonus_rate','music_type_base_bonus_rate','music_tag_base_bonus_rate'].map(_id => ({_id, _value:0})),
      VipRankBonus:sequence(2, rank => ({_vipRank:rank, _vipBonusType:7, _value:rank - 1})),
      BandItem:[101,102].map(_id => ({_id, _bandId:1})),
      BandItemSkillEffect:[101,102].flatMap(id => sequence(30, level => ({_bandItemId:id, _level:level,
        _skillEffectType:1000, _skillTargetIDs:[], _effectValue:level}))),
      LiveMusic:[1,2].map(_id => ({_id, _musicType:1, _bestMusicTagIDs:[]})), Event:[]
    }};
}
