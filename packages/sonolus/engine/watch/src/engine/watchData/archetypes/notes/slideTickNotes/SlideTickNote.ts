import { Note } from '../Note.js'

export abstract class SlideTickNote extends Note {
    preprocess() {
        super.preprocess()

        if (this.hasInput) this.archetypeLife.miss = -100
    }
}
