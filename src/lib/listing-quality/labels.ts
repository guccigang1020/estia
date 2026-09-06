/**
 * The Hebrew a person reads.
 *
 * ══ EVERY LINE SAYS WHAT TO DO, NOT WHAT IS WRONG ═══════════════════════════
 *
 * "התיאור קצר" is true and useless. "הוסיפו תיאור" is an instruction. A
 * quality report is read by somebody with twenty minutes who wants to know
 * which twenty minutes to spend, so each label is the next action rather than
 * a diagnosis.
 *
 * The `not_assessed` lines are the exception and they are the most important
 * ones here: they say why the product cannot judge it, so nobody spends an
 * afternoon looking for the setting that would turn it on.
 */

import type { ListingCheckArea } from './types'

export const LISTING_AREA_LABEL: Readonly<Record<ListingCheckArea, string>> =
  Object.freeze({
    description: 'תיאור',
    photos: 'תמונות',
    amenities: 'שירותים',
    capacity: 'תפוסה',
    pricing: 'תמחור',
    policies: 'מדיניות',
    location: 'מיקום',
    reputation: 'מוניטין',
  })

export const LISTING_CHECK_LABEL: Readonly<Record<string, string>> =
  Object.freeze({
    'property.description_present':
      'כתבו תיאור לנכס. מתחת ל-220 תווים אורח לא מבין מה המקום.',
    'property.description_full':
      'הרחיבו את התיאור — מה יש מסביב, למי המקום מתאים, מה מייחד אותו.',
    'property.cover_image':
      'העלו תמונה ראשית לנכס. בלעדיה אין מה להראות ברשימה.',
    'property.photo_count': 'הוסיפו תמונות. מתחת לחמש אי אפשר לדמיין את המקום.',
    'property.amenities':
      'סמנו את השירותים בנכס. רשימה קצרה כמעט תמיד אומרת שלא מילאו, ולא שאין.',
    'property.coordinates':
      'סמנו את הנכס על המפה. בלי קואורדינטות אורח ישאל בטלפון איפה זה בדיוק.',
    'property.locality': 'ציינו יישוב או אזור.',
    'property.cancellation_policy':
      'כתבו את מדיניות הביטול במילים. אורח שלא מצא אותה מראש הוא ויכוח בהמשך.',
    'property.house_rules': 'כתבו כללי בית — שעות שקט, מסיבות, חיות מחמד.',
    'property.guest_rating':
      'אין דירוגי אורחים במוצר הזה. ההרשאות review.view ו-review.manage קיימות בקטלוג ואין להן טבלה — כלומר אין מה למדוד, לא שהנכס לא מדורג.',

    'unit.description_present': 'כתבו תיאור ליחידה עצמה, לא רק לנכס.',
    'unit.cover_image': 'העלו תמונה ראשית ליחידה.',
    'unit.photo_count': 'הוסיפו תמונות של היחידה.',
    'unit.amenities': 'סמנו את השירותים ביחידה.',
    'unit.capacity_stated': 'מלאו כמה אורחים, כמה חדרים וכמה מקלחות.',
    'unit.capacity_plausible':
      'מספר האורחים לא מסתדר עם מספר המיטות. זו הסיבה הנפוצה ביותר לאורח שמגיע ומגלה שהמקום אינו מה שהזמין.',
    'unit.base_price': 'קבעו מחיר בסיס ליחידה.',
    'unit.fees_decided':
      'החליטו על דמי ניקיון ופיקדון — גם אפס זו החלטה. מה שאסור הוא שלא יוגדרו, כי אז האורח פוגש אותם בסוף.',
    'unit.size_stated': 'ציינו שטח במ״ר.',
    'unit.conversion_rate':
      'אין מקור אנליטיקה במוצר הזה, ולכן אין צפיות ואין שיעור המרה למדוד.',
    'unit.market_position':
      'אין נתוני שוק במוצר הזה. השוואה למתחרים תהיה אפשרית רק כשיהיה מקור נתונים אמיתי — עד אז כל מספר כאן יהיה המצאה.',
  })

/** A line for a code nobody added a label for. Never blank. */
export function labelFor(code: string): string {
  return LISTING_CHECK_LABEL[code] ?? code
}
