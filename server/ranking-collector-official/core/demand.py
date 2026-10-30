# L3 — GEB
# Input: A job's bounded player and song demand, its sampler and the update channel.
# Output: Player profiles and song rankings sent as durable callbacks.
# Pos: [Map](../../L2.md); on-demand reads that share a run with ranking collection.
# Effects/Dependencies: Authenticated game RPCs at the sampler's pace. A rejected read ends demand, never the account.
import time
from pathlib import Path

from google.protobuf import json_format

from transport import pool_from_file

# Only the JP descriptor set carries these services; the messages they share with intl are identical.
DESCRIPTORS = Path(__file__).parent / 'total-descriptors.pb'
NOT_FOUND = '5'
PLAYER_RPCS = 2
PACE_SECONDS = 2


class DemandStopped(Exception):
    def __init__(self, receipt):
        self.receipt = receipt


class Demand:
    def __init__(self, job, sampler, updates, deadline):
        self.job, self.sampler, self.updates = job, sampler, updates
        self.budget = min(time.time() + 40, deadline - 30)

    def room(self, requests):
        return time.time() + requests * PACE_SECONDS < self.budget

    def read(self, service, method, request, label):
        path = '/app.%s/%s' % (service, method)
        package = service.split('.')[0]
        receipt, response, _ = self.sampler.rpc(path, self.sampler.message('app.%s.%sRequest' % (package, method), request),
                                                'app.%s.%sResponse' % (package, method), label)
        return receipt, response

    def body(self, response):
        return json_format.MessageToDict(response, preserving_proto_field_name=True)

    def observed(self, receipt):
        from datetime import datetime
        return int(datetime.fromisoformat(receipt['received_at']).timestamp() * 1000)

    def player(self, profile_id):
        receipt, response = self.read('friend.FriendService', 'FindByProfileID',
                                      {'player_profile_id': profile_id}, 'player-' + profile_id)
        if response is None:
            if str(receipt.get('grpc_status')) != NOT_FOUND:
                raise DemandStopped(receipt)
            self.updates.send('player-profile', profileId=profile_id, found=False, observedAtMs=self.observed(receipt))
            return
        profile = self.body(response).get('player_profile', {})
        favorite, favorite_status = None, None
        if profile.get('id'):
            favorite_status, status = self.read('player.PlayerService', 'GetPlayerFavoriteStatus',
                                                {'player_id': profile['id']}, 'favorite-' + profile_id)
            if status is not None:
                favorite = self.body(status).get('total_favorite', '0')
        self.updates.send('player-profile', profileId=profile_id, found=True, profile=profile, totalFavorite=favorite,
                          observedAtMs=self.observed(favorite_status or receipt))

    def song(self, music_id):
        receipt, response = self.read('livemusic.LiveMusicService', 'GetRanking', {'music_id': music_id},
                                      'song-%d' % music_id)
        if response is None:
            raise DemandStopped(receipt)
        players = self.body(response).get('players', [])
        if len(players) > 100:
            raise ValueError('invalid song ranking')
        self.updates.send('song-ranking', musicId=str(music_id), players=players, observedAtMs=self.observed(receipt))

    def run(self):
        """Returns the receipt that ended demand, or None when every request in budget finished."""
        pool, self.sampler.pool = self.sampler.pool, pool_from_file(DESCRIPTORS)
        try:
            for music_id in self.job.get('songRankings', [])[:4]:
                if not self.room(1):
                    return None
                self.song(int(music_id))
            for profile_id in self.job.get('playerLookups', [])[:16]:
                if not self.room(PLAYER_RPCS):
                    return None
                self.player(profile_id)
        except DemandStopped as stopped:
            return stopped.receipt
        finally:
            self.sampler.pool = pool
        return None
