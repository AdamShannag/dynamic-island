package race

import "math/rand/v2"

var passages = []string{
	"The quick brown fox jumps over the lazy dog near the old wooden fence, and somewhere behind the barn a rooster calls out to greet the morning before the farmhands even reach the fields.",
	"A gentle breeze drifted through the open window as the kettle began to whistle softly, filling the small kitchen with warmth while the first light of dawn spread slowly across the quiet street outside.",
	"She walked along the beach at sunrise, collecting shells before the tide came back in, pausing now and then to watch the gulls wheel overhead and the waves fold gently over the smooth wet sand.",
	"The old library smelled of dust and paper, and every shelf held a story worth reading, tucked between worn leather spines and faded index cards that nobody had touched in what felt like decades.",
	"Rain tapped against the roof all night while the cat slept curled up by the fire, and by morning the garden outside was glistening, every leaf and petal still heavy with the last of the storm.",
	"He planted tomatoes and basil in the small garden behind his grandmother's house, carefully turning the soil each weekend and talking to the plants as though they could somehow understand him.",
	"The train rumbled across the bridge just as the sun dipped below the distant hills, casting long golden shadows across the valley while passengers pressed their faces to the cool glass windows.",
	"Children laughed and chased each other around the park until the streetlights came on, their voices echoing between the old oak trees long after their parents had called them in for dinner.",
	"A warm cup of coffee and a good book are often all anyone really needs on a quiet morning, especially when the rest of the world outside is still half asleep and the house is wrapped in silence.",
	"The mountain trail wound upward through pine trees before opening onto a wide green meadow, where wildflowers swayed in the wind and a single hawk circled slowly against the pale blue sky.",
	"Every autumn the town held a small festival with music, pumpkins, and fresh apple cider, and even the grumpiest shopkeepers seemed to soften a little once the smell of cinnamon filled the square.",
	"The old clock in the hallway ticked steadily, marking each passing hour with quiet patience, a sound so familiar that nobody in the house noticed it anymore except on the stillest nights.",
	"Fishermen pulled their boats onto the shore as storm clouds gathered over the dark water, working quickly and quietly, the way people do when they have done the same thing every evening for years.",
	"She practiced the piano every evening, slowly learning the melody note by careful note, until one night the whole piece came together and she played it through without a single mistake.",
	"The city lights sparkled below as the airplane began its long descent toward the runway, and for a moment the whole skyline looked like something scattered across black velvet by careless hands.",
	"A stray dog followed the baker home, hoping for a bit of bread from the morning batch, and by the end of the week the baker had quietly started setting aside a little extra, just in case.",
	"The scientist carefully labeled each sample before placing it back in the cold storage room, double checking every entry in the log even though she had done this exact routine a thousand times before.",
	"Wind swept across the open plains, bending the tall grass in long rippling waves, and from a distance the whole field looked almost like the surface of a restless, slow moving green sea.",
	"The old lighthouse keeper climbed the narrow spiral stairs every night without fail, lighting the lamp just as the last color drained from the sky and the first ships began to appear on the horizon.",
	"Snow fell quietly over the small village, softening every rooftop and fence post until the whole street looked unfamiliar, and children pressed their noses against frosted windows waiting to go outside.",
}

func randomPassage() string {
	return passages[rand.IntN(len(passages))]
}
