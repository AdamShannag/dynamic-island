package race

import "math/rand/v2"

var passages = []string{
	"The quick brown fox jumps over the lazy dog near the old wooden fence.",
	"A gentle breeze drifted through the open window as the kettle began to whistle softly.",
	"She walked along the beach at sunrise, collecting shells before the tide came back in.",
	"The old library smelled of dust and paper, and every shelf held a story worth reading.",
	"Rain tapped against the roof all night while the cat slept curled up by the fire.",
	"He planted tomatoes and basil in the small garden behind his grandmother's house.",
	"The train rumbled across the bridge just as the sun dipped below the distant hills.",
	"Children laughed and chased each other around the park until the streetlights came on.",
	"A warm cup of coffee and a good book are often all anyone really needs on a quiet morning.",
	"The mountain trail wound upward through pine trees before opening onto a wide green meadow.",
	"Every autumn the town held a small festival with music, pumpkins, and fresh apple cider.",
	"The old clock in the hallway ticked steadily, marking each passing hour with quiet patience.",
	"Fishermen pulled their boats onto the shore as storm clouds gathered over the dark water.",
	"She practiced the piano every evening, slowly learning the melody note by careful note.",
	"The city lights sparkled below as the airplane began its long descent toward the runway.",
	"A stray dog followed the baker home, hoping for a bit of bread from the morning batch.",
	"The scientist carefully labeled each sample before placing it back in the cold storage room.",
	"Wind swept across the open plains, bending the tall grass in long rippling waves.",
}

func randomPassage() string {
	return passages[rand.IntN(len(passages))]
}
