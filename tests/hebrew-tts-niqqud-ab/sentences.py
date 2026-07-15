# 10 test sentences pulled from the Keren v2 prompt (system-prompt.he.ts).
# Chosen to stress the three things niqqud is supposed to help with:
#   - NAMES        קרן / קורן / שטרית  (proper nouns the TTS has no lexicon for)
#   - NUMBERS      spoken-out phone digits, "30", שבוע/שבועיים
#   - MIXED ENGLISH  ClickScales / onboarding / CRM / AI embedded in Hebrew
# id, tag, text
SENTENCES = [
    ("01", "greeting/name+en", "שלום, מדברת קרן מ-ClickScales. איך אני יכולה לעזור?"),
    ("02", "founder-disambig/name+en", "קורן הוא המייסד של ClickScales, והוא זה שיעביר את הדמו."),
    ("03", "phone-readback/numbers", "רק לוודא — אפס חמש אפס, תשע שבע, שמונה שמונה, ארבע חמש?"),
    ("04", "gender-suffix+number", "מה מספר הטלפון שלך? אשלח לך אישור."),
    ("05", "setup/mixed-en", "ההקמה לוקחת שבוע עד שבועיים, וכוללת onboarding מותאם אישית."),
    ("06", "crm/translit-en", "כן, הסוכן מתחבר ל-CRM שלך ומגיע עם דשבורד מלא לצפייה בכל השיחות והלידים."),
    ("07", "demo-offer/number+gender", "בוא נקבע שיחת דמו קצרה של שלושים דקות שבה תראה איך זה עובד בפועל."),
    ("08", "fullname-confirm", "רק לוודא — קורן שטרית, נכון?"),
    ("09", "discovery/gender-suffix", "כמה פניות נכנסות אליך ביום, פחות או יותר?"),
    ("10", "ai-admission/en", "אני סוכנת AI, אבל אני יכולה להעביר הודעה לצוות שלנו שיחזרו אליך."),
]
