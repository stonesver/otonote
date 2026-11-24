import {withServer} from './game-servers.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value, min, max, optional = false) => optional && value == null
  || Number.isSafeInteger(value) && value >= min && value <= max;

export function rankingScoreAnomaly(score) {
  return score === 2147483647 ? 'score-int32-max' : null;
}

export function validateHighScoreDeck(deck) {
  if (deck == null) return;
  if (!object(deck) || !number(deck.totalPower, 1, 2147483647, true)
    || !Array.isArray(deck.cards) || deck.cards.length > 5) throw Error('Invalid high score deck');
  const slots = new Set(), orders = new Set();
  for (const row of deck.cards) {
    if (!object(row) || !number(row.slot, 0, 4) || slots.has(row.slot)
      || !number(row.performanceOrder, 0, 4) || orders.has(row.performanceOrder)) throw Error('Invalid deck slot');
    slots.add(row.slot); orders.add(row.performanceOrder);
    for (const kind of ['member', 'support']) {
      const card = row[kind];
      if (card == null) continue;
      if (!object(card) || !number(card.masterId, 1, Number.MAX_SAFE_INTEGER)
        || !number(card.exp, 0, 2147483647, true) || !number(card.rank, 1, 5, true)
        || kind === 'member' && ['awake', 'liveSkillLevel', 'performanceSkillLevel'].some(key => !number(card[key], 1, 5, true))) {
        throw Error('Invalid deck card');
      }
    }
  }
}

export function rankingCard(kind, masterId, catalog) {
  if (!['member', 'support'].includes(kind)) return undefined;
  return catalog?.[kind]?.[String(masterId)];
}

export function rankingCardLevel(card, kind, catalog) {
  if (!card || card.exp == null || !Number.isFinite(card.exp)) return null;
  const info = rankingCard(kind, card.masterId, catalog);
  const profile = info?.rarity != null ? catalog?.growthCurves?.[`${kind}:${info.rarity}`] : null;
  if (!profile?.curve?.length) return null;
  let level = profile.curve[0][0] ?? 1;
  for (const [lv, rawExp] of profile.curve) {
    if (rawExp > card.exp) break;
    level = lv;
  }
  let maxLevel = null;
  if (kind === 'member' && card.awake != null && profile.limits) {
    maxLevel = profile.limits[card.awake] ?? profile.limits[String(card.awake)] ?? null;
  } else if (kind === 'support' && card.rank != null && Array.isArray(profile.limits)) {
    maxLevel = profile.limits[card.rank - 1] ?? null;
  }
  return maxLevel != null ? Math.min(level, maxLevel) : level;
}

const profileHosts = new Set(['l14-prod-hk-patch-sirius.gamerfusiontech.com', 'l12-prod-hk-patch-sirius.gamerfusiontech.com',
  'l14-prod-sg-patch-sirius.bilibiligame.net', 'l12-prod-sg-patch-sirius.bilibiligame.net']);
export function validatePlayerProfile(profile) {
  if (profile == null) return;
  if (!object(profile) || !number(profile.avatarMasterId, 1, Number.MAX_SAFE_INTEGER, true)
    || !Array.isArray(profile.profileCardImages) || profile.profileCardImages.length > 8) throw Error('Invalid public profile');
  for (const image of profile.profileCardImages) {
    if (typeof image !== 'string' || image.length > 2048 || /[\u0000-\u0020]/.test(image)) throw Error('Invalid profile image');
    const url = new URL(image);
    if (url.protocol !== 'https:' || !profileHosts.has(url.hostname) || url.username || url.password || url.search || url.hash
      || url.port && url.port !== '443') throw Error('Invalid profile image');
  }
}

export function orderedDeckSlots(deck) {
  return Array.from({length: 5}, (_, slot) => deck?.cards?.find(row => row.slot === slot) ?? {
    slot, performanceOrder: null, member: null, support: null,
  });
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

let rowDetailsSequence = 0;

export function createRankingRow(entry, {en, catalog, server, scoreLabel}) {
  const language = en ? 'en-US' : 'zh-CN', format = value => value.toLocaleString(language);
  const deck = entry.highScoreDeck, known = Boolean(deck?.cards?.length);
  const row = node('li', 'pr-row');
  row.dataset.playerRank = String(entry.rank);
  if (entry.playerId) row.dataset.playerId = String(entry.playerId);
  if (entry.name) row.dataset.playerName = String(entry.name);
  if (entry.rank <= 3) row.dataset.podium = String(entry.rank);

  const orderedSlots = known ? orderedDeckSlots(deck) : [];
  const leadSlot = orderedSlots[2]?.member || orderedSlots[0]?.member || orderedSlots.find(s => s.member)?.member;
  const leadInfo = leadSlot ? rankingCard('member', leadSlot.masterId, catalog) : rankingCard('member', entry.profile?.avatarMasterId, catalog);
  if (leadInfo?.image) {
    const ambient = node('div', 'pr-row-ambient');
    ambient.setAttribute('aria-hidden', 'true');
    const bgImg = node('img');
    bgImg.src = leadInfo.image;
    bgImg.alt = '';
    bgImg.loading = 'lazy';
    bgImg.decoding = 'async';
    bgImg.addEventListener('error', () => ambient.remove(), {once: true});
    ambient.append(bgImg);
    row.append(ambient);
  }

  const main = node('div', 'pr-row-main');

  // 1. Sculptural Borderless Rank
  const rankCol = node('div', 'pr-rank-col');
  const rankNum = node('span', 'pr-rank', format(entry.rank));
  rankNum.setAttribute('aria-label', `${en ? 'Rank' : '排名'} ${entry.rank}`);
  rankCol.append(rankNum);

  // 2. Player Identity & Team Power
  const personCol = node('div', 'pr-person-col');
  const avatar = node('span', 'pr-avatar');
  const avatarInfo = rankingCard('member', entry.profile?.avatarMasterId, catalog);
  if (avatarInfo?.image) {
    const image = node('img');
    image.src = avatarInfo.image;
    image.alt = en ? 'Player avatar' : '玩家头像';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => avatar.replaceChildren(node('span', '', entry.name?.slice(0, 1) || '♪')), {once: true});
    avatar.append(image);
  } else {
    avatar.append(node('span', '', entry.name?.slice(0, 1) || '♪'));
  }

  const personMeta = node('div', 'pr-person-meta');
  personMeta.append(node('span', 'pr-player-name', entry.name || (en ? 'Unnamed player' : '未命名玩家')));
  const powerLine = node('span', 'pr-power-inline', `${en ? 'Power' : '综合力'} ${deck?.totalPower ? format(deck.totalPower) : '—'}`);
  personMeta.append(powerLine);

  const profileImages = entry.profile?.profileCardImages || [];
  if (profileImages.length) {
    const namecard = node('span', 'pr-profile-card');
    const image = node('img');
    let index = 0;
    image.src = profileImages[index];
    image.alt = en ? 'Player profile card' : '玩家名片';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => {
      if (++index < profileImages.length) image.src = profileImages[index];
      else namecard.remove();
    });
    namecard.append(image);
    personMeta.append(namecard);
  }
  personCol.append(avatar, personMeta);

  function portrait(card, kind, width = 104, height = 138) {
    const info = card && rankingCard(kind, card.masterId, catalog);
    const label = info?.name || (card ? `${en ? 'Card' : '卡片'} #${card.masterId}` : (en ? 'Not provided' : '未提供'));
    const frame = node('span', `pr-portrait${kind === 'support' ? ' pr-portrait--support' : ''}`);
    if (info?.image) {
      const image = node('img');
      image.src = info.image;
      image.alt = label;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.width = width;
      image.height = height;
      image.addEventListener('error', () => {
        frame.replaceChildren(node('span', 'pr-image-fallback', card ? `#${card.masterId}` : '—'));
      }, {once: true});
      frame.append(image);
    } else {
      frame.append(node('span', 'pr-image-fallback', card ? `#${card.masterId}` : '—'));
    }
    return frame;
  }

  function cardTooltip(card, kind, info, level) {
    const title = info?.name || (card ? `${en ? 'Card' : '卡片'} #${card.masterId}` : (en ? 'Not provided' : '未提供'));
    if (!card) return title;
    const parts = [title];
    if (info?.rarityLabel) parts.unshift(`[${info.rarityLabel}]`);
    if (level != null) parts.push(`Lv.${level}`);
    if (kind === 'member') {
      if (card.rank != null) parts.push(`${en ? 'Awakening' : '觉醒'} ${card.rank}/5`);
      if (card.awake != null) parts.push(`${en ? 'Breakthrough' : '特训'} ${card.awake}/5`);
      if (card.liveSkillLevel != null || card.performanceSkillLevel != null) {
        parts.push(`${en ? 'Skills' : '技能'} Lv.${card.liveSkillLevel ?? '—'}/${card.performanceSkillLevel ?? '—'}`);
      }
    } else if (card.rank != null) {
      parts.push(`${en ? 'Breakthrough' : '突破'} ${card.rank}/5`);
    }
    return parts.join(' · ');
  }

  // 3. Vertical Member Cards with Bottom-Embedded Horizontal Support Card & Visual Leader
  const team = node('div', 'pr-team-preview pr-team-grid');
  team.setAttribute('aria-label', en ? 'High-score team' : '最高分队伍');

  if (known) {
    for (const slot of orderedSlots) {
      const isLeader = slot.slot === 2;
      const unit = node('div', 'pr-slot-unit');
      if (isLeader) unit.dataset.leader = 'true';
      const visual = node('div', 'pr-slot-visual');

      // Base Portrait: Vertical 84x100 Member Card with embedded Attr, Rarity & Level
      const member = slot.member;
      const memberInfo = member && rankingCard('member', member.masterId, catalog);
      const memberLv = member && rankingCardLevel(member, 'member', catalog);
      const memberTip = cardTooltip(member, 'member', memberInfo, memberLv);
      const memberTile = node(memberInfo?.href ? 'a' : 'div', 'pr-member-tile');
      if (memberInfo?.href) memberTile.href = withServer(memberInfo.href, server);
      memberTile.title = (isLeader ? (en ? '[Leader] ' : '[队长] ') : '') + memberTip;
      memberTile.append(portrait(member, 'member', 84, 100));

      const attrInfo = memberInfo?.attr != null ? catalog?.attributes?.[String(memberInfo.attr)] : null;
      if (attrInfo?.image) {
        const icon = node('img', 'pr-tile-attr');
        icon.src = attrInfo.image;
        icon.alt = attrInfo.name || '';
        icon.title = attrInfo.name || '';
        icon.width = 15;
        icon.height = 15;
        icon.loading = 'lazy';
        icon.decoding = 'async';
        icon.addEventListener('error', () => icon.remove(), {once: true});
        memberTile.append(icon);
      }

      if (member) {
        const rarityInfo = memberInfo?.rarity != null ? catalog?.rarities?.[String(memberInfo.rarity)] : null;
        if (rarityInfo?.image) {
          const rarityWrap = node('span', 'pr-tile-rarity');
          const rarityImg = node('img', 'pr-rarity-img');
          rarityImg.src = rarityInfo.image;
          rarityImg.alt = rarityInfo.label || memberInfo?.rarityLabel || '';
          rarityImg.loading = 'lazy';
          rarityImg.decoding = 'async';
          rarityImg.addEventListener('error', () => {
            rarityWrap.replaceChildren(node('span', 'pr-rarity-text', rarityInfo.label || memberInfo?.rarityLabel || ''));
          }, {once: true});
          rarityWrap.append(rarityImg);
          memberTile.append(rarityWrap);
        } else if (memberInfo?.rarityLabel) {
          const rarityWrap = node('span', 'pr-tile-rarity');
          rarityWrap.append(node('span', 'pr-rarity-text', memberInfo.rarityLabel));
          memberTile.append(rarityWrap);
        }

        const lvText = memberLv != null ? `Lv.${memberLv}` : (member.awake != null ? `${en ? 'T' : '破'}${member.awake}` : '—');
        memberTile.append(node('span', 'pr-tile-lv', lvText));
      }
      visual.append(memberTile);

      // Embedded Inset: Horizontal 76x34 Support Card with embedded Support Rarity, Level & Breakthrough
      const support = slot.support;
      const supportInfo = support && rankingCard('support', support.masterId, catalog);
      const supportLv = support && rankingCardLevel(support, 'support', catalog);
      if (support) {
        const supportTile = node(supportInfo?.href ? 'a' : 'div', 'pr-support-tile');
        if (supportInfo?.href) supportTile.href = withServer(supportInfo.href, server);
        supportTile.title = cardTooltip(support, 'support', supportInfo, supportLv);
        supportTile.append(portrait(support, 'support', 76, 34));

        const sRarityInfo = supportInfo?.rarity != null ? catalog?.rarities?.[String(supportInfo.rarity)] : null;
        if (sRarityInfo?.image) {
          const sRarityWrap = node('span', 'pr-support-rarity');
          const sRarityImg = node('img', 'pr-support-rarity-img');
          sRarityImg.src = sRarityInfo.image;
          sRarityImg.alt = sRarityInfo.label || supportInfo?.rarityLabel || '';
          sRarityImg.loading = 'lazy';
          sRarityImg.decoding = 'async';
          sRarityImg.addEventListener('error', () => sRarityWrap.remove(), {once: true});
          sRarityWrap.append(sRarityImg);
          supportTile.append(sRarityWrap);
        }

        const sMeta = node('span', 'pr-support-meta');
        const sLvText = supportLv != null ? `Lv.${supportLv}` : (en ? 'Snap' : '留影');
        sMeta.append(node('span', 'pr-support-lv', sLvText));
        if (support.rank != null) {
          sMeta.append(node('span', 'pr-support-rank', `+${support.rank}`));
        }
        supportTile.append(sMeta);
        visual.append(supportTile);
      } else {
        const emptySupport = node('div', 'pr-support-tile pr-support-tile--empty');
        emptySupport.title = en ? 'No snapshot equipped' : '未装备留影';
        emptySupport.append(node('span', '', '—'));
        visual.append(emptySupport);
      }

      if (isLeader) {
        const crown = node('span', 'pr-leader-crown');
        crown.setAttribute('aria-hidden', 'true');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 12');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '9');
        svg.setAttribute('fill', 'currentColor');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M1.5 10.5h13l1-7-4 3-3.5-5-3.5 5-4-3 1 7z');
        svg.append(path);
        crown.append(svg);
        visual.append(crown);
      }

      unit.append(visual);
      team.append(unit);
    }
  } else {
    team.append(node('span', 'pr-team-missing', en ? 'Team not provided for this record.' : '本次采集未附带这位玩家的队伍记录'));
  }

  // 4. Hero Score & Details Trigger
  const scoreCol = node('div', 'pr-score-col');
  const scoreBox = node('div', 'pr-score');
  scoreBox.append(node('small', '', scoreLabel), node('strong', '', format(entry.score)));
  const anomaly = rankingScoreAnomaly(entry.score);
  const anomalyReason = en
    ? 'Score reaches the signed 32-bit integer limit (2,147,483,647).'
    : '分数达到 32 位有符号整数上限（2,147,483,647）。';
  if (anomaly) {
    const badge = node('span', 'pr-score-warning', en ? 'Unusual score' : '成绩异常');
    badge.title = anomalyReason;
    badge.dataset.rule = anomaly;
    scoreCol.append(scoreBox, badge);
  } else {
    scoreCol.append(scoreBox);
  }

  const detailsId = `pr-deck-${++rowDetailsSequence}`;
  const toggleBtn = node('button', 'ui-btn-ghost pr-details-toggle');
  toggleBtn.type = 'button';
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.setAttribute('aria-controls', detailsId);
  const toggleLabel = node('span', 'pr-details-toggle-label', en ? 'Details' : '详情');
  const toggleChevron = node('span', 'pr-toggle-chevron');
  toggleChevron.setAttribute('aria-hidden', 'true');
  toggleBtn.append(toggleLabel, toggleChevron);
  scoreCol.append(toggleBtn);

  main.append(rankCol, personCol, team, scoreCol);
  row.append(main);

  // Expandable Full-Card Details Drawer
  const details = node('details', 'pr-player');
  details.id = detailsId;
  const hiddenSummary = node('summary', 'visually-hidden', en ? `Expand details for ${entry.name}` : `查看 ${entry.name} 队伍详情`);
  details.append(hiddenSummary);
  row.append(details);

  toggleBtn.addEventListener('click', () => {
    details.open = !details.open;
  });

  function detailCard(card, kind) {
    const info = card && rankingCard(kind, card.masterId, catalog);
    const level = card && rankingCardLevel(card, kind, catalog);
    const box = node('div', 'pr-detail-card');
    const title = info?.name || (card ? `${en ? 'Card' : '卡片'} #${card.masterId}` : (en ? 'Not provided' : '未提供'));
    const link = node(info?.href ? 'a' : 'div', 'pr-card-link');
    if (info?.href) link.href = withServer(info.href, server);
    link.append(portrait(card, kind, 64, 85), node('span', 'pr-card-name', title));
    box.append(link);
    const stats = node('dl', 'pr-card-stats');
    const add = (label, value) => {
      const pair = node('div');
      pair.append(node('dt', '', label), node('dd', '', value));
      stats.append(pair);
    };
    if (card) {
      if (info?.rarityLabel) add(en ? 'Rarity' : '稀有度', info.rarityLabel);
      if (level != null) add(en ? 'Level' : '等级', `Lv.${level}`);
      if (kind === 'member') {
        if (card.rank != null) add(en ? 'Awakening' : '觉醒', `${card.rank}/5`);
        if (card.awake != null) add(en ? 'Breakthrough' : '突破（特训）', `${card.awake}/5`);
        if (card.liveSkillLevel != null) add(en ? 'Live skill' : '演出技能', `Lv.${card.liveSkillLevel}`);
        if (card.performanceSkillLevel != null) add(en ? 'Performance skill' : '表演技能', `Lv.${card.performanceSkillLevel}`);
      } else if (card.rank != null) {
        add(en ? 'Breakthrough' : '突破', `${card.rank}/5`);
      }
    }
    if (stats.childElementCount) box.append(stats);
    return box;
  }

  details.addEventListener('toggle', () => {
    toggleBtn.setAttribute('aria-expanded', details.open ? 'true' : 'false');
    toggleLabel.textContent = details.open ? (en ? 'Hide' : '收起') : (en ? 'Details' : '详情');
    if (!details.open || details.dataset.built) return;
    details.dataset.built = 'true';
    const panel = node('div', 'pr-deck-panel');
    const heading = node('div', 'pr-deck-heading');
    heading.append(
      node('h3', '', en ? 'Highest-score team' : '最高分队伍详情'),
      node('p', '', en ? 'Full card names, profile cards, and growth stats saved with this score.' : '完整卡名、名片与取得该成绩时保存的卡面养成记录。')
    );
    panel.append(heading);
    if (profileImages.length) {
      const gallery = node('section', 'pr-profile-gallery');
      gallery.setAttribute('aria-label', en ? 'Player profile cards' : '玩家名片');
      gallery.append(node('h4', '', en ? 'Profile cards' : '玩家名片'));
      const pictures = node('div', 'pr-profile-pictures');
      for (const source of profileImages) {
        const image = node('img');
        image.src = source;
        image.alt = en ? 'Player profile card' : '玩家名片';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove(), {once: true});
        pictures.append(image);
      }
      gallery.append(pictures);
      panel.append(gallery);
    }
    if (anomaly) {
      panel.append(node('p', 'pr-score-warning-detail', anomalyReason + (en
        ? ' Automatically flagged for this score; this is not a confirmed cheating verdict.'
        : ' 此标记由成绩规则自动判定，不代表已确认作弊。')));
    }
    if (!known) {
      panel.append(node('p', 'pr-detail-empty', en ? 'This snapshot did not include a team.' : '本次采集未取得这位玩家的队伍信息。'));
    } else {
      const slots = node('div', 'pr-deck-slots');
      for (const slot of orderedDeckSlots(deck)) {
        const cell = node('section', 'pr-deck-slot');
        if (slot.slot === 2) cell.dataset.leader = 'true';
        cell.append(
          node('h4', '', `${en ? 'Slot' : '位置'} ${slot.slot + 1}${slot.slot === 2 ? (en ? ' · Leader' : ' · 队长') : ''}`),
          node('p', 'pr-order', slot.performanceOrder == null ? '—' : `${en ? 'Performance order' : '演出顺序'} ${slot.performanceOrder + 1}`),
          node('span', 'pr-card-kind', en ? 'Member' : '成员卡'),
          detailCard(slot.member, 'member'),
          node('span', 'pr-card-kind pr-support-label', en ? 'Support' : '留影'),
          detailCard(slot.support, 'support')
        );
        slots.append(cell);
      }
      panel.append(slots);
    }
    details.append(panel);
  });
  return row;
}
