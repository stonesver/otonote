import {selectedControlValues} from './filter-controls.mjs';

export function readCardBandConstraints(member, support) {
  const constraints = {};
  for (const [field, key] of [[member, 'bandId'], [support, 'supportBandId']]) {
    const values = selectedControlValues(field).map(Number);
    if (values.length) constraints[key] = values;
  }
  return constraints;
}

export function cardBandFilterSummary(member, support, locale = 'zh-CN') {
  return [[member, locale === 'en' ? 'Member band' : '成员乐队'],
    [support, locale === 'en' ? 'Memory associated band' : '留影关联乐队']].flatMap(([field, label]) => {
    const values = selectedControlValues(field);
    if (!values.length) return [];
    const names = [...field.options].filter(option => values.includes(option.value)).map(option => option.textContent);
    return [`${label}${locale === 'en' ? ': ' : '：'}${names.join(locale === 'en' ? ', ' : '、')}`];
  }).join(' · ');
}
