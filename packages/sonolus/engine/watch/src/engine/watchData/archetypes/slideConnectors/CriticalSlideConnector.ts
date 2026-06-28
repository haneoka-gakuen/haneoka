import { skin } from '../../skin.js'
import { archetypes } from '../index.js'
import { SlideConnector } from './SlideConnector.js'

export class CriticalSlideConnector extends SlideConnector {
    sprites = {
        missed: skin.sprites.normalSlideConnectorNormal,
        normal: skin.sprites.normalSlideConnectorNormal,
        pressed: skin.sprites.normalSlideConnectorNormal,
    }

    get slideStartNote() {
        return archetypes.CriticalSlideStartNote
    }
}
