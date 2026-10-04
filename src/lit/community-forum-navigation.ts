import {LitElement, html, nothing} from 'lit';
import {repeat} from 'lit/directives/repeat.js';
import {icon} from './ui/icon';
import {RequestScope} from '../lib/request-scope';
import {readCommunityForumDirectory} from '../lib/community-forum-directory';
import {JsonResponseError} from './shared/catalog';
import {clientText} from '../i18n/client';
import {localeFromPath} from '../i18n/locales';
import {navigationDocumentUrl} from '../lib/document-url';
import {projectForumNavigation, type ForumNavigationSnapshot, type ForumNavigationPayload} from '../lib/community-forum-navigation';

let sequence = 0;
/** Global drawer directory; community pages also publish the active board. */
export class CommunityForumNavigation extends LitElement {
  static properties = { locale:{}, snapshot:{state:true}, busy:{state:true} };
  declare locale:string;
  declare private snapshot:ForumNavigationSnapshot;
  declare private busy:boolean;
  private readonly requests = new RequestScope();
  private readonly directoryRequests = new RequestScope();
  private realm: string | undefined;
  private directorySignal: AbortSignal | undefined;
  private directoryInitialized = false;
  private pagePath: string | undefined;
  private readonly syncPage = () => {this.syncPageContext();};
  private readonly revokeDirectory = () => {this.invalidate();void this.loadDirectory();};
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
  constructor() { super();this.locale='ja';this.snapshot={forums:[]};this.busy=false; }
  createRenderRoot() { return this; }
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('astro:page-load', this.syncPage);
    this.syncPageContext();
    window.addEventListener('haneoka:session-changed', this.revokeDirectory);
    window.addEventListener('haneoka:community-forums-changed', this.revokeDirectory);
    if (!this.directoryInitialized) void this.loadDirectory();
  }
  /** Persisted links follow the incoming document without rereading its directory. */
  private syncPageContext(published = false): void {
    const url = navigationDocumentUrl();
    const path = url.pathname.replace(/\/+$/, '');
    this.locale = localeFromPath(path) ?? this.locale;
    const parts = path.split('/').filter(Boolean);
    const community = parts.indexOf('community');
    let active: string | null = null;
    if (community >= 0 && parts[community+1] === 'forums' && parts.length === community+3) {
      const slug = parts[community+2];
      active = this.snapshot.forums.find(forum => forum.enabled && forum.capabilities.canRead &&
        encodeURIComponent(forum.slug) === slug)?.id ?? null;
    } else if (community >= 0 && parts[community+1] === 'posts' && (published || path === this.pagePath)) {
      active = this.snapshot.activeForumId ?? null;
    }
    this.pagePath = path;
    this.snapshot = {...this.snapshot, activeForumId:active};
    if (published || this.snapshot.forums.length) this.syncActiveGroup(published);
    this.requestUpdate();
  }
  private syncActiveGroup(prune: boolean): void {
    const groups=this.groups();
    const active=groups.find(group=>group.links.some(link=>link.active))?.id;
    if(active && (active!==this.activeGroup || this.snapshot.activeForumId!==this.activeForum))this.expanded.set(active,true);
    this.activeGroup=active;
    this.activeForum=this.snapshot.activeForumId;
    if(prune) for(const key of this.expanded.keys())if(!groups.some(group=>group.id===key))this.expanded.delete(key);
  }
  private async loadDirectory(): Promise<void> {
    if (this.directorySignal && this.directoryRequests.current(this.directorySignal)) return;
    const signal = this.directorySignal = this.directoryRequests.begin();
    this.busy = true;
    let confirmed = false;
    try {
      const data = await readCommunityForumDirectory(signal, viewer => {
        if (!this.isConnected || !this.directoryRequests.current(signal)) return;
        if ((this.realm !== undefined && this.realm !== viewer.realm) ||
            (this.viewerId !== undefined && this.viewerId !== viewer.userId)) {
          this.requests.cancel();this.snapshot={forums:[]};
          this.expanded.clear();this.activeGroup=undefined;this.activeForum=undefined;
        }
        this.realm=viewer.realm;confirmed=true;
      });
      if (!this.isConnected || !this.directoryRequests.current(signal)) return;
      const token = this.begin(JSON.stringify([data.viewer.userId, location.pathname, 0]));
      this.commit(token, {...data, viewerId:data.viewer.userId, locale:this.locale,
        activeForumId:this.snapshot.activeForumId});
    } catch (error) {
      if (!this.isConnected || !this.directoryRequests.current(signal)) return;
      this.requests.cancel();
      if (!confirmed || (error instanceof JsonResponseError && [401,403,404].includes(error.status)))
        this.snapshot={forums:[]};
      this.busy=false;
    } finally {
      if (this.directorySignal === signal) {
        if (this.directoryRequests.current(signal)) this.directoryInitialized=true;
        this.directorySignal=undefined;
      }
    }
  }
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
    if(this.requestedViewer!==this.viewerId) this.snapshot={forums:[]};
    this.busy=true;
    this.context=contextKey;
    return this.requests.begin();
  }
  commit(signal:AbortSignal,snapshot:ForumNavigationPayload):boolean {
    if(!this.isConnected || !this.requests.current(signal))return false;
    if(snapshot.viewerId!==this.requestedViewer)return false;
    if(snapshot.viewerId!==this.viewerId) {
      this.expanded.clear();this.activeGroup=undefined;this.activeForum=undefined;
    }
    this.viewerId=snapshot.viewerId;this.locale=snapshot.locale;this.busy=false;
    this.snapshot=structuredClone(snapshot);
    this.syncPageContext(true);
    return true;
  }
  /** Ordinary same-session refresh cancels old work without removing readable links. */
  refresh():void {this.requests.cancel();void this.loadDirectory();}
  /** Transfer a persisted navigation instance to a new page owner, or settle a failure. */
  release(signal?:AbortSignal):void {
    if(signal && !this.requests.current(signal))return;
    this.requests.cancel();this.busy=false;
  }
  // Known identity/ACL revocation always removes private DTOs immediately.
  invalidate():void {this.requests.cancel();this.directoryRequests.cancel();this.snapshot={forums:[]};this.busy=false;}
  disconnectedCallback() {
    document.removeEventListener('astro:page-load', this.syncPage);
    window.removeEventListener('haneoka:session-changed', this.revokeDirectory);
    window.removeEventListener('haneoka:community-forums-changed', this.revokeDirectory);
    this.directoryRequests.cancel();
    this.requests.cancel();
    super.disconnectedCallback();
    // Astro may synchronously move transition:persist nodes to the incoming document.
    queueMicrotask(()=>{
      if(this.isConnected)return;
      this.invalidate();this.expanded.clear();this.activeGroup=undefined;this.activeForum=undefined;
      this.viewerId=undefined;this.requestedViewer=undefined;this.context=undefined;this.realm=undefined;this.directoryInitialized=false;this.pagePath=undefined;
    });
  }
  private groups() {
    return projectForumNavigation(this.snapshot,this.locale,
      clientText(this.locale,'communityPage.forums','Boards'),this.availableIcons);
  }
  render() {
    const groups=this.groups();
    return html`<div class="community-nav-boards" aria-busy=${String(this.busy)}>${repeat(groups,group=>group.id,group=>{
      const id=this.instance+'-'+encodeURIComponent(group.id),expanded=this.expanded.get(group.id)??false;
      const links=html`<ul class="nav__children community-nav-links" role="list">
        ${repeat(group.links,link=>link.id,link=>html`<li><a class="nav-item community-nav-board-link"
          data-community-forum-id=${link.id} href=${link.href} aria-current=${link.active?'page':nothing}>
          ${icon(link.icon,18)}<span lang=${link.language}>${link.title}</span>
        </a></li>`)}</ul>`;
      if(group.id==='visible-forums')return links;
      return html`<div class="nav__section community-nav-group" data-community-forum-group=${group.id}>
          <button class="nav__section-toggle nav__disclosure" type="button"
            data-community-forum-toggle=${group.id} aria-expanded=${String(expanded)}
            aria-controls=${id} aria-label=${group.title}
            @click=${()=>{this.expanded.set(group.id,!expanded);this.requestUpdate();}}>
            <span lang=${group.language}>${group.title}</span>${icon('expand_more')}
          </button>
        <div class="nav__branch" id=${id} ?hidden=${!expanded}>
          ${links}
        </div>
      </div>`;
    })}</div>`;
  }
}
if(!customElements.get('community-forum-navigation'))customElements.define('community-forum-navigation',CommunityForumNavigation);
