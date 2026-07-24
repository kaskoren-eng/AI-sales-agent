import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import en from './locales/en.json'
import he from './locales/he.json'

export const SUPPORTED_LANGUAGES = ['en', 'he'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]

/** RTL is decided by language, in exactly one place. */
export function dirFor(lng: string): 'rtl' | 'ltr' {
  return lng.startsWith('he') ? 'rtl' : 'ltr'
}

/** Keep <html lang> and <html dir> in lockstep with the active language. */
function applyDocumentDirection(lng: string): void {
  const root = document.documentElement
  root.lang = lng.startsWith('he') ? 'he' : 'en'
  root.dir = dirFor(lng)
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      he: { translation: he },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES,
    // en-US / he-IL collapse to en / he
    load: 'languageOnly',
    nonExplicitSupportedLngs: true,
    returnNull: false,
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'keren.lang',
      caches: ['localStorage'],
    },
    // Resources are bundled inline, so init is synchronous — no Suspense boundary needed.
    react: { useSuspense: false },
    saveMissing: import.meta.env.DEV,
    missingKeyHandler: import.meta.env.DEV
      ? (_lngs, _ns, key) => console.warn(`[i18n] missing key: ${key}`)
      : undefined,
  })

applyDocumentDirection(i18n.language)
i18n.on('languageChanged', applyDocumentDirection)

export default i18n
