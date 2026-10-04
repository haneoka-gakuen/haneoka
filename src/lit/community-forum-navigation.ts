import {LitElement, html, nothing} from 'lit';
import {repeat} from 'lit/directives/repeat.js';
import {icon} from './ui/icon';
import {RequestScope} from '../lib/request-scope';
import {clientText} from '../i18n/client';
import {projectForumNavigation, type ForumNavigationSnapshot, type ForumNavigationPayload} from '../lib/community-forum-navigation';

let sequence = 0;
/** Controlled drawer view; the active community owner supplies fresh ACL DTOs. */
export class CommunityForumNavigation extends LitElement {
  static properties = { locale:{}, snapshot:{state:true} };
  declare locale:string;
  declare private snapshot:ForumNavigationSnapshot;
  private readonly requests = new RequestScope();
  private readonly instance = 'community-forum-nav-'+ ++sequence;
  private readonly expanded = new Map<string,boolean>();
  private context: string | null | undefined;
  private activeGroup: string | undefined;
  private activeForum: string | null | undefined;
  private viewerId: string | undefined;
  private requestedViewer: string | undefined;
  /** Supply the actual current sprite ids, not the whole upstream icon collection. */
  availableIcons: ReadonlySet<string> = new Set([
    'forum','chat','style','emoji_emotions','music_note','auto_stories',
    'groups','menu_book','help','lightbulb','flag',
  ]);
  constructor() { super();this.locale='ja';this.snapshot={forums:[]}; }
  createRenderRoot() { return this; }
  begin(contextKey:string):AbortSignal {
    let context:unknown;
    try {context=JSON.parse(contextKey);}
    catch(error) {this.invalidate();throw error;}
    if(!Array.isArray(context) || typeof context[0]!=='string') {
      this.invalidate();throw new TypeError('Community navigation requires a confirmed viewer context');
    }
    this.requestedViewer=context[0];
    if(this.requestedViewer!==this.viewerId) {
      this.expanded.clear();this.activeGroup=undefined;this.activeForum=undefined;
    }
    if(this.context!==contextKey) {
      this.snapshot={forums:[]};
    }
    this.context=contextKey;
    return this.requests.begin();
  }
  commit(signal:AbortSignal,snapshot:ForumNavigationPayload):boolean {
    if(!this.isConnected || !this.requests.current(signal))return false;
    if(snapshot.viewerId!==this.requestedViewer)return false;
    if(snapshot.viewerId!==this.viewerId) {
      this.expanded.clear();this.activeGroup=undefined;this.activeForum=undefined;
    }
    this.viewerId=snapshot.viewerId;this.locale=snapshot.locale;
    this.snapshot=structuredClone(snapshot);
    const groups=this.groups();
    const active=groups.find(group=>group.links.some(link=>link.active))?.id;
    if(active && (active!==this.activeGroup || snapshot.activeForumId!==this.activeForum))this.expanded.set(active,true);
    this.activeGroup=active;
    this.activeForum=snapshot.activeForumId;
    for(const key of this.expanded.keys())if(!groups.some(group=>group.id===key))this.expanded.delete(key);
    this.requestUpdate();
    return true;
  }
  // Revoking DTOs preserves presentation hints until the confirmed viewer/board changes.
  invalidate():void {this.requests.cancel();this.snapshot={forums:[]};}
  disconnectedCallback() {
    this.invalidate();this.expanded.clear();this.activeGroup=undefined;this.activeForum=undefined;
    this.viewerId=undefined;this.requestedViewer=undefined;this.context=undefined;
    super.disconnectedCallback();
  }
  private groups() {
    return projectForumNavigation(this.snapshot,this.locale,
      clientText(this.locale,'communityPage.forums','Boards'),this.availableIcons);
  }
  render() {
    const groups=this.groups();
    return html`<div class="community-nav-boards">${repeat(groups,group=>group.id,group=>{
      const id=this.instance+'-'+encodeURIComponent(group.id),expanded=this.expanded.get(group.id)??false;
      return html`<div class="community-nav-group" data-community-forum-group=${group.id}>
        <div class="nav__destination">
          <span class="nav-item community-nav-group-label" lang=${group.language}>${group.title}</span>
          <button class="icon-button nav__disclosure" type="button"
            data-community-forum-toggle=${group.id} aria-expanded=${String(expanded)}
            aria-controls=${id} aria-label=${group.title}
            @click=${()=>{this.expanded.set(group.id,!expanded);this.requestUpdate();}}>
            ${icon('expand_more')}
          </button>
        </div>
        <div class="nav__branch" id=${id} ?hidden=${!expanded}>
          <ul class="nav__children community-nav-links" role="list">
          ${repeat(group.links,link=>link.id,link=>html`<li><a
            class="nav-item community-nav-board-link" data-community-forum-id=${link.id}
            href=${link.href} aria-current=${link.active?'page':nothing}>
            ${icon(link.icon)}<span lang=${link.language}>${link.title}</span>
          </a></li>`)}</ul>
        </div>
      </div>`;
    })}</div>`;
  }
}
if(!customElements.get('community-forum-navigation'))customElements.define('community-forum-navigation',CommunityForumNavigation);
