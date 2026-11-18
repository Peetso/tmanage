/**
 * 57-17 WTP — the willingness-to-pay card's English copy (`PricingSurvey.*`), shared by the Home
 * card and the Platform admin answers list. Arabic and the other locales come from the catalogs.
 */
export const PRICING_SURVEY_COPY = {
  eyebrow: 'One question',
  question: 'What would you pay per person each month?',
  body: 'TManage is free during the beta. Your answer helps us set a fair price. Only the TManage team sees it.',
  bandsLabel: 'Price per person each month',
  band_nothing: 'Nothing',
  band_under_5: 'Under $5',
  band_5_9: '$5–$9',
  band_10_15: '$10–$15',
  band_over_15: 'More than $15',
  noteLabel: 'Anything to add? (optional)',
  notePlaceholder: 'Type here',
  send: 'Send answer',
  sending: 'Sending your answer',
  skip: 'Skip',
  askOnce: 'We ask once. Skip and we will not ask again.',
  sent: 'Sent',
  thanks: 'Thank you. Your answer is saved.',
  sentBody: 'The TManage team reads every answer.',
  sendFailed: 'Your answer was not sent. Try again.',
} as const;

export type PricingSurveyCopyKey = keyof typeof PRICING_SURVEY_COPY;
