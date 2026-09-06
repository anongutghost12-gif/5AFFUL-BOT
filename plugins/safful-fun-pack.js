'use strict'

// ---------------------------------------------------------------------------
// FUN pack (readable) — replaces the obfuscated fun.smd versions of
// .dare / .define / .fact / .joke / .question / .truth / .quotes with fresh,
// expanded content (~50 new entries each) and a .define that uses the free
// dictionaryapi.dev service (no API key) instead of the dead service the old
// command called.
// ---------------------------------------------------------------------------
const { cmd, commands } = require('../lib/plugins')

const FUN_NAMES = new Set(['dare', 'define', 'fact', 'joke', 'joke2', 'question', 'truth', 'quotes'])

function namesOf(command) {
  return [command && command.pattern, command && command.cmdname]
    .concat(Array.isArray(command && command.alias) ? command.alias : [])
    .filter(Boolean)
    .map(name => String(name).toLowerCase().trim())
}

function removeLegacyFunCommands() {
  for (let index = commands.length - 1; index >= 0; index--) {
    const command = commands[index]
    if (command && command.filename !== __filename && namesOf(command).some(name => FUN_NAMES.has(name))) {
      commands.splice(index, 1)
    }
  }
}
removeLegacyFunCommands()
setImmediate(removeLegacyFunCommands)

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)]
}

const DARES = [
  'Do your best celebrity impression until the next dare.',
  'Text your mom something nice right now and show the chat.',
  'Let someone else type one message to any of your contacts.',
  'Sing the chorus of your favourite song out loud.',
  'Do 15 push-ups on the spot.',
  'Speak in a British accent for the next 3 turns.',
  'Post your current wallpaper and explain why you picked it.',
  'Show the last photo in your camera roll.',
  'Wear your shirt backwards for 5 minutes.',
  'Make a paper plane and fly it across the room.',
  'Do 20 jumping jacks while counting out loud in another language.',
  'Let the group pick your profile picture for the next hour.',
  'Say the alphabet backwards as fast as you can.',
  'Call a friend and tell them a random fun fact.',
  'Do an impression of a robot for the next 3 messages.',
  'Show your most recent search history (screen it first!).',
  'Balance a book on your head for 30 seconds.',
  'Give a 30-second motivational speech to the group.',
  'Do your best dinosaur impression.',
  'Let someone write a sentence for you to send to a contact.',
  'Stand up, spin around 5 times, then sit back down.',
  'Name 5 countries that start with the letter S in 15 seconds.',
  'Mimic a news anchor reporting the weather.',
  'Hum a song and let the group guess it.',
  'Do the robot dance for 15 seconds.',
  'Say one compliment to every person in the chat.',
  'Show a baby photo of yourself if you have one.',
  'Try to lick your elbow (or explain why you cannot).',
  'Send a voice note whispering a random word 3 times.',
  'Do 10 squats slowly while counting in Spanish.',
  'Tell the group your most embarrassing moment.',
  'Act out a movie title using only gestures.',
  'Speak only in questions for the next 3 turns.',
  'Recite a poem you remember from school.',
  'Draw a self-portrait with your non-dominant hand and share it.',
  'Do an opera-style rendition of a children’s song.',
  'Keep a straight face while everyone tries to make you laugh.',
  'Send the first song in your playlist to the chat.',
  'Do a dramatic slow-motion walk across the room.',
  'Share one skill you are secretly proud of.',
  'Do 25 arm circles forward then backward.',
  'Imitate your favourite cartoon character for one minute.',
  'Give the group a 3-item survival kit for a desert island.',
  'Say "I love sandwiches" in three different languages.',
  'Do a plank for 20 seconds while humming a tune.',
  'Make up a short rap about the person above you.',
  'Text your sibling or a friend a silly pun.',
  'Do your best villain laugh for 10 seconds.',
  'Let the group choose between two foods and eat/name it.',
  'Describe your day using only emojis.',
  'Do a 10-second dramatic death scene.',
  'Name 10 animals in 20 seconds.',
]

const FACTS = [
  'A day on Venus is longer than a year on Venus.',
  'Octopuses have three hearts and blue blood.',
  'Honey never spoils — archaeologists found 3,000-year-old honey still edible.',
  'Bananas are berries, but strawberries are not.',
  'Sharks existed before trees.',
  'Your brain uses about 20% of your body’s energy.',
  'Lightning strikes Earth about 8 million times a day.',
  'The Eiffel Tower grows about 15 cm taller in summer.',
  'A group of flamingos is called a "flamboyance".',
  'Water can boil and freeze at the same time (the triple point).',
  'The shortest war in history lasted 38 minutes.',
  'Cows have best friends and get stressed when separated.',
  'There are more possible chess games than atoms in the observable universe.',
  'Your nose can remember 50,000 different scents.',
  'The human body contains enough iron to make a small nail.',
  'Axolotls can regenerate limbs, hearts, and parts of their brains.',
  'The Great Wall of China is not visible from space with the naked eye.',
  'A jiffy is an actual unit of time: 1/100th of a second.',
  'Pigeons can recognise themselves in a mirror.',
  'The longest hiccuping spree lasted 68 years.',
  'Sea otters hold hands while sleeping so they do not drift apart.',
  'The smell of freshly cut grass is a plant distress signal.',
  'Cleopatra lived closer in time to the Moon landing than to the building of the pyramids.',
  'A cloud can weigh over a million pounds.',
  'Octopus suckers can taste what they touch.',
  'The first computer "bug" was an actual moth stuck in a relay.',
  'Kangaroos cannot walk backwards.',
  'Your stomach produces a new lining every few days.',
  'Dolphins call each other by name.',
  'The world’s oldest known recipe is for beer.',
  'Some turtles can breathe through their butts.',
  'There is a species of jellyfish that is biologically immortal.',
  'Cheetahs can go from 0 to 100 km/h in about 3 seconds.',
  'The Sahara Desert was once green and full of rivers.',
  'Your fingerprints start forming before you are born.',
  'A bolt of lightning is about 5 times hotter than the surface of the Sun.',
  'The human eye can distinguish about 10 million different colours.',
  'Peanuts are not nuts — they are legumes.',
  'Phytoplankton in the ocean produce about half of Earth’s oxygen.',
  'Crocodiles cannot stick out their tongues.',
  'There are more trees on Earth than stars in the Milky Way.',
  'The speed of sound is about 343 metres per second.',
  'Butterflies taste with their feet.',
  'Sloths can hold their breath longer than dolphins.',
  'The Moon is slowly drifting away from Earth, about 3.8 cm a year.',
  'Your skin sheds about 30,000 to 40,000 dead cells every minute.',
  'Mangoes are related to cashews and pistachios.',
  'The inventor of the Pringles can is buried in one.',
  'Frogs can freeze solid in winter and thaw out alive in spring.',
  'The word "queue" can be pronounced with just one letter sounding: Q.',
]

const QUESTIONS = [
  'What is the best advice you ever ignored?',
  'If you could master any instrument overnight, which would you pick?',
  'What movie or show do you rewatch more than you admit?',
  'If your life had a theme song, what would it be?',
  'What is a skill you want to learn just for fun?',
  'If you could teleport anywhere right now, where would you go?',
  'What is the most overrated food in your opinion?',
  'If you could switch lives with any animal for a day, which one?',
  'What is a small thing that makes your day instantly better?',
  'Would you rather be able to speak every language or play every instrument?',
  'What is the last thing that made you laugh really hard?',
  'If you could delete one fear forever, which would it be?',
  'What is your dream travel destination and why?',
  'If you could time travel, would you visit the past or the future?',
  'What is a hobby you wish more people tried?',
  'What fictional character would you want as a best friend?',
  'If you won a big prize today, what is the first thing you would buy?',
  'What is the best meal you have ever had?',
  'If you could only listen to one artist for a year, who?',
  'What is something you believed as a kid that turned out to be false?',
  'If you could add one hour to the day, when would you add it?',
  'What is your guilty-pleasure show or song?',
  'If your friends had to describe you in three words, what would they be?',
  'What is a place you would love to live for a year?',
  'If you could have any superpower for practical everyday use, which one?',
  'What is the most useful thing you learned that school never taught you?',
  'If you could have dinner with any three people (alive or not), who?',
  'What is your favourite way to spend a free afternoon?',
  'What is something you are oddly good at?',
  'If your life were a book, what would the current chapter be called?',
  'What is one thing you would tell your younger self?',
  'Would you rather always be 10 minutes early or always 10 minutes late?',
  'What is a scent that brings back a strong memory for you?',
  'If you could instantly become an expert in one subject, what would it be?',
  'What is the best gift you have ever received?',
  'What movie scene makes you emotional no matter how many times you see it?',
  'If you had to eat one cuisine for the rest of your life, which one?',
  'What is something you do that most people find weird?',
  'If you could visit any fictional world, where would you go?',
  'What is the best decision you have made so far?',
  'What are you most looking forward to this year?',
  'If you could rename yourself, what would you pick?',
  'What is a simple pleasure you never get tired of?',
  'Would you rather have a personal chef or a personal trainer?',
  'What is the most beautiful place you have ever seen in person?',
  'If you could learn the truth about one mystery, which one?',
  'What is your comfort food and why?',
  'If you could instantly finish one project, what would it be?',
  'What is the most adventurous thing you have ever eaten?',
  'If you could swap wardrobes with any celebrity, who would you choose?',
]

const TRUTHS = [
  'What is the most embarrassing thing you have done in public?',
  'Have you ever pretended to like a gift you hated?',
  'What is a secret you have never told your family?',
  'Who was your first celebrity crush?',
  'Have you ever broken something and blamed someone else?',
  'What is the weirdest thing you have googled?',
  'Have you ever lied about your age?',
  'What is your most irrational fear?',
  'Have you ever read someone else’s messages by accident (or on purpose)?',
  'What is the biggest trouble you ever got into as a kid?',
  'Have you ever faked being sick to avoid something?',
  'What is something you do only when nobody is watching?',
  'Have you ever snooped in someone’s phone?',
  'What is the worst date you have ever been on?',
  'Have you ever re-gifted something you did not like?',
  'What is a habit you cannot break?',
  'Have you ever talked to yourself out loud and been caught?',
  'What is the most money you have ever lost or wasted?',
  'Have you ever sent a message to the wrong person? What did it say?',
  'What is something you bought that you immediately regretted?',
  'Have you ever cheated at a game?',
  'What is your most embarrassing ringtone or alarm?',
  'Have you ever fallen asleep in a weird place?',
  'What is the last lie you told?',
  'Have you ever cried at a movie? Which one?',
  'What is a food you secretly love that people would judge you for?',
  'Have you ever stayed in something longer than you wanted out of politeness?',
  'What is the silliest thing you have argued about?',
  'Have you ever eavesdropped on a conversation?',
  'What is the most childish thing you still do?',
  'Have you ever hidden food so you would not have to share it?',
  'What is the worst haircut you have ever had?',
  'Have you ever pretended to know a song?',
  'What is something you are secretly proud of?',
  'Have you ever judged someone by their shoes?',
  'What is the most awkward thing you have ever said to a crush?',
  'Have you ever laughed at something you should not have?',
  'What is your biggest "I told you so" moment?',
  'Have you ever taken something that was not yours?',
  'What is the most times you have watched the same movie?',
  'Have you ever regretted a tattoo or piercing?',
  'What is the longest you have gone without showering?',
  'Have you ever exaggerated a story to sound cooler?',
  'What is a song you secretly love but would never admit to?',
  'Have you ever been caught singing in the mirror?',
  'What is the most embarrassing search history you would never share?',
  'Have you ever faked understanding something in a conversation?',
  'What is the worst thing you have ever cooked?',
  'Have you ever sent a risky message and regretted it instantly?',
  'What is the one thing you would delete from the internet about yourself?',
]

const QUOTES = [
  '“The only way to do great work is to love what you do.” — Steve Jobs',
  '“In the middle of difficulty lies opportunity.” — Albert Einstein',
  '“Whether you think you can or you think you can’t, you’re right.” — Henry Ford',
  '“It always seems impossible until it’s done.” — Nelson Mandela',
  '“The best time to plant a tree was 20 years ago. The second best time is now.” — Chinese proverb',
  '“Success is not final, failure is not fatal: it is the courage to continue that counts.” — Winston Churchill',
  '“Do what you can, with what you have, where you are.” — Theodore Roosevelt',
  '“The future belongs to those who believe in the beauty of their dreams.” — Eleanor Roosevelt',
  '“Happiness is not something ready made. It comes from your own actions.” — Dalai Lama',
  '“Don’t watch the clock; do what it does. Keep going.” — Sam Levenson',
  '“You miss 100% of the shots you don’t take.” — Wayne Gretzky',
  '“The journey of a thousand miles begins with a single step.” — Lao Tzu',
  '“What we achieve inwardly will change outer reality.” — Plutarch',
  '“It is during our darkest moments that we must focus to see the light.” — Aristotle',
  '“Quality is not an act, it is a habit.” — Aristotle',
  '“Believe you can and you’re halfway there.” — Theodore Roosevelt',
  '“The only limit to our realization of tomorrow is our doubts of today.” — Franklin D. Roosevelt',
  '“Life is what happens when you’re busy making other plans.” — John Lennon',
  '“The mind is everything. What you think you become.” — Buddha',
  '“Strive not to be a success, but rather to be of value.” — Albert Einstein',
  '“Two roads diverged in a wood, and I—I took the one less traveled by.” — Robert Frost',
  '“The secret of getting ahead is getting started.” — Mark Twain',
  '“If you look at what you have in life, you’ll always have more.” — Oprah Winfrey',
  '“Well done is better than well said.” — Benjamin Franklin',
  '“Nothing is impossible, the word itself says ‘I’m possible’!” — Audrey Hepburn',
  '“Challenges are what make life interesting and overcoming them is what makes life meaningful.” — Joshua J. Marine',
  '“Dream big and dare to fail.” — Norman Vaughan',
  '“Everything you’ve ever wanted is on the other side of fear.” — George Addair',
  '“The only person you are destined to become is the person you decide to be.” — Ralph Waldo Emerson',
  '“It’s not whether you get knocked down, it’s whether you get up.” — Vince Lombardi',
  '“Stay hungry, stay foolish.” — Steve Jobs',
  '“Simplicity is the ultimate sophistication.” — Leonardo da Vinci',
  '“Turn your wounds into wisdom.” — Oprah Winfrey',
  '“You are never too old to set another goal or to dream a new dream.” — C. S. Lewis',
  '“The way to get started is to quit talking and begin doing.” — Walt Disney',
  '“Do one thing every day that scares you.” — Eleanor Roosevelt',
  '“It does not matter how slowly you go as long as you do not stop.” — Confucius',
  '“Our greatest glory is not in never falling, but in rising every time we fall.” — Confucius',
  '“Fall seven times and stand up eight.” — Japanese proverb',
  '“The harder I work, the luckier I get.” — Samuel Goldwyn',
  '“I have not failed. I’ve just found 10,000 ways that won’t work.” — Thomas Edison',
  '“Genius is 1% inspiration and 99% perspiration.” — Thomas Edison',
  '“Success usually comes to those who are too busy to be looking for it.” — Henry David Thoreau',
  '“If you want to lift yourself up, lift up someone else.” — Booker T. Washington',
  '“A person who never made a mistake never tried anything new.” — Albert Einstein',
  '“The best way to predict the future is to create it.” — Peter Drucker',
  '“Act as if what you do makes a difference. It does.” — William James',
  '“You don’t have to be great to start, but you have to start to be great.” — Zig Ziglar',
  '“Little by little, one travels far.” — J. R. R. Tolkien',
  '“Not all those who wander are lost.” — J. R. R. Tolkien',
]

const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'I told my computer I needed a break and now it will not stop sending me vacation ads.',
  'Why did the developer go broke? Because they used up all their cache.',
  'There are only 10 types of people: those who understand binary and those who do not.',
  'Why was the computer cold? It left its Windows open.',
  'A SQL query walks into a bar and asks two tables if it can join them.',
  'Why do Java developers wear glasses? Because they cannot C#.',
  'I would tell you a UDP joke, but you might not get it.',
  'Why did the web developer walk out of the restaurant? Because the place had no cache.',
  'How do trees access the internet? They log in.',
  'Why was the JavaScript developer sad? They did not Node how to Express themselves.',
  'I broke my keyboard. Now I have no way to Ctrl myself.',
  'Why did the scarecrow win an award? Because he was outstanding in his field.',
  'What do you call a fish with no eyes? A fsh.',
  'Why could the bicycle not stand up? It was two-tired.',
  'I am reading a book about anti-gravity. It is impossible to put down.',
  'What do you call fake spaghetti? An impasta.',
  'Why did the tomato turn red? Because it saw the salad dressing.',
  'Parallel lines have so much in common — it is a shame they will never meet.',
  'Why do cows wear bells? Because their horns do not work.',
  'What do you call a bear with no teeth? A gummy bear.',
  'I used to play piano by ear, but now I use my hands.',
  'Why did the math book look sad? It had too many problems.',
  'What do you call a sleeping dinosaur? A dino-snore.',
  'Why can you not trust an atom? Because they make up everything.',
  'How does the ocean say hi? It waves.',
  'What do you call cheese that is not yours? Nacho cheese.',
  'Why did the golfer bring two pairs of trousers? In case he got a hole in one.',
  'What do you get when you cross a snowman and a vampire? Frostbite.',
  'Why are elevator jokes so good? They work on many levels.',
  'I told my wife she should embrace her mistakes. She hugged me.',
  'What do you call a factory that makes okay products? A satisfactory.',
  'Why do bees hum? Because they forgot the words.',
  'What did the left eye say to the right eye? Between you and me, something smells.',
  'Why did the stadium get hot after the game? All the fans left.',
  'How do you make holy water? You boil the hell out of it.',
  'What is the best time to go to the dentist? Tooth-hurty.',
  'Why do not scientists trust atoms? They make up everything.',
  'What do you call an alligator in a vest? An investigator.',
  'Why did the man put his money in the freezer? He wanted cold hard cash.',
  'What do you call a lazy kangaroo? A pouch potato.',
  'Why did the picture go to jail? Because it was framed.',
  'What do you call a pig that does karate? A pork chop.',
  'Why was the broom late? It over-swept.',
  'What do you call a pile of cats? A meow-ntain.',
  'Why did the phone go to school? To get a better ring tone.',
  'What did the grape do when it got stepped on? It let out a little wine.',
  'Why did the hipster burn his tongue? He drank his coffee before it was cool.',
  'What do you call a dinosaur with an extensive vocabulary? A thesaurus.',
  'Why should you never trust stairs? They are always up to something.',
  'What do you call a snowman with a six-pack? An abdominal snowman.',
  'Why did the coffee file a police report? It got mugged.',
]

cmd({
  pattern: 'joke',
  alias: ['joke2'],
  desc: 'Get a random joke',
  category: 'fun',
  filename: __filename,
}, async (message) => {
  if (!message || typeof message.reply !== 'function') return undefined
  return message.reply(`*😂 JOKE*\n\n${randomItem(JOKES)}`)
})

cmd({
  pattern: 'dare',
  desc: 'Get a random dare',
  category: 'fun',
  filename: __filename,
}, async (message) => {
  if (!message || typeof message.reply !== 'function') return undefined
  return message.reply(`*🎯 DARE*\n\n${randomItem(DARES)}`)
})

cmd({
  pattern: 'fact',
  desc: 'Get a random fun fact',
  category: 'fun',
  filename: __filename,
}, async (message) => {
  if (!message || typeof message.reply !== 'function') return undefined
  return message.reply(`*🤯 FACT*\n\n${randomItem(FACTS)}`)
})

cmd({
  pattern: 'question',
  desc: 'Get a random conversation question',
  category: 'fun',
  filename: __filename,
}, async (message) => {
  if (!message || typeof message.reply !== 'function') return undefined
  return message.reply(`*💬 QUESTION*\n\n${randomItem(QUESTIONS)}`)
})

cmd({
  pattern: 'truth',
  desc: 'Get a random truth question',
  category: 'fun',
  filename: __filename,
}, async (message) => {
  if (!message || typeof message.reply !== 'function') return undefined
  return message.reply(`*🫣 TRUTH*\n\n${randomItem(TRUTHS)}`)
})

cmd({
  pattern: 'quotes',
  desc: 'Get a random inspirational quote',
  category: 'fun',
  filename: __filename,
}, async (message) => {
  if (!message || typeof message.reply !== 'function') return undefined
  return message.reply(`*✨ QUOTE*\n\n${randomItem(QUOTES)}`)
})

cmd({
  pattern: 'define',
  use: '<word>',
  desc: 'Get the dictionary definition of a word (free API, no key needed)',
  category: 'fun',
  filename: __filename,
}, async (message, text) => {
  if (!message || typeof message.reply !== 'function') return undefined
  const word = String(text || '').trim().split(/\s+/)[0]
  if (!word) {
    return message.reply(`*Usage:* ${String(require('../config').HANDLERS || '.')[0] || '.'}define <word>\n\nExample: .define resilient`)
  }
  const clean = raw => String(raw || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const firstDef = data => {
    const langBlock = data && data.en
    if (!Array.isArray(langBlock) || !langBlock.length) return null
    const pos = langBlock[0].partOfSpeech || ''
    const defs = (langBlock[0].definitions || []).map(d => clean(d.definition)).filter(Boolean)
    const example = clean((langBlock[0].parsedExamples || [])[0] && (langBlock[0].parsedExamples[0].example))
    return { pos, definition: defs[0] || '', example }
  }
  const trySource = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    const data = await response.json()
    return data && data.en ? data : null
  }
  let data = null
  let usedSource = ''
  try {
    data = await trySource(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`)
    if (data) usedSource = 'Wiktionary'
    else {
      data = await trySource(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`)
      if (data) {
        usedSource = 'Dictionary'
        data = { en: [{ partOfSpeech: (data[0] && data[0].meanings && data[0].meanings[0] && data[0].meanings[0].partOfSpeech) || '',
          definitions: data[0].meanings.flatMap(m => (m.definitions || []).map(d => ({ definition: d.definition }))),
          parsedExamples: (data[0].meanings || []).flatMap(m => (m.definitions || []).filter(d => d.example).map(d => ({ example: d.example }))) }] }
      }
    }
  } catch {
    data = null
  }
  const parsed = data && firstDef(data)
  if (!parsed || !parsed.definition) {
    return message.reply(`*No definition found for "${word}".* Check the spelling or try another word.`)
  }
  const lines = [
    `*${word.charAt(0).toUpperCase() + word.slice(1)}*`,
    '',
  ]
  if (parsed.pos) lines.push(`_${parsed.pos}_`)
  lines.push(parsed.definition)
  if (parsed.example) lines.push(`\n📎 *Example:* ${parsed.example}`)
  if (usedSource) lines.push(`\n_— via ${usedSource}_`)
  return message.reply(lines.join('\n'))
})

module.exports = { DARES, FACTS, JOKES, QUESTIONS, TRUTHS, QUOTES }
