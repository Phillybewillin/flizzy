import 'dotenv/config';
import fastify from 'fastify';
import { META, MOVIES } from '@consumet/extensions';
import unidecode from 'unidecode';
import cors from '@fastify/cors';

const app = fastify({ logger: true });
const tmdbApi = process.env.TMDB_KEY;

const PROVIDER_CLASSES = {
    flixhq: MOVIES.FlixHQ,
    dramacool: MOVIES.DramaCool,
    fmovies: MOVIES.Fmovies,
    goku: MOVIES.Goku,
    kissasian: MOVIES.KissAsian,
    moviehdwatch: MOVIES.MovieHdWatch,
    viewasian: MOVIES.ViewAsian,
    sflix: MOVIES.SFlix,
    multimovies: MOVIES.MultiMovies,
    netflixmirror: MOVIES.NetflixMirror,
};

const DEFAULT_PROVIDER_ORDER = [
    'flixhq', 'sflix', 'goku', 'fmovies', 'moviehdwatch',
    'dramacool', 'kissasian', 'viewasian', 'multimovies', 'netflixmirror',
].filter(key => PROVIDER_CLASSES[key]);

// --- Timeouts for individual provider operations (in milliseconds) ---
// These need to be aggressive to avoid Vercel's global timeout.
// Max total for one provider = SEARCH_TIMEOUT + MEDIA_INFO_TIMEOUT + SOURCES_TIMEOUT
const SEARCH_TIMEOUT = 3000;       // 3 seconds
const MEDIA_INFO_TIMEOUT = 3000;   // 3 seconds
const SOURCES_TIMEOUT = 4000;      // 4 seconds
// Max time per provider: 3+3+4 = 10 seconds. If Vercel timeout is e.g. 15-30s, this allows a few to race.

app.register(cors, {
    origin: ['https://zilla-xr.xyz', 'http://localhost:5173', ...(process.env.NODE_ENV === 'development' ? ['http://127.0.0.1:5173'] : [])],
    methods: ['GET', 'POST']
});

app.get('/', async (request, reply) => {
    return {
        intro: "Welcome to the unofficial multi-provider resolver (Fast Concurrent Mode).",
        documentation: "API documentation: https://github.com/Inside4ndroid/AIO-StreamSource (original base)",
        author: "Original by Inside4ndroid, modified for speed and failover."
    };
});

// Helper: Timeout for individual promises
async function timeoutPromise(promise, ms, providerName, operationName, request) {
    let timer;
    const timeoutError = new Error(`[${providerName}] ${operationName} timed out after ${ms}ms`);
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            if (request && request.log) {
                request.log.warn(timeoutError.message);
            }
            reject(timeoutError);
        }, ms);
    });
    try {
        const result = await Promise.race([promise, timeout]);
        return result;
    } finally {
        clearTimeout(timer);
    }
}


// Helper function to calculate match score (same as before)
function calculateScore(providerItem, tmdbInfo, request) {
    let score = 0;
    if (!providerItem || !tmdbInfo) return 0;
    const normalizeTitle = (title) => unidecode(title.toLowerCase().replace(/[^\w\s]/gi, ''));
    if (providerItem.title && tmdbInfo.title) {
        const normProviderTitle = normalizeTitle(providerItem.title);
        const normTmdbTitle = normalizeTitle(tmdbInfo.title);
        if (normProviderTitle === normTmdbTitle) score += 30;
        else if (normProviderTitle.includes(normTmdbTitle) || normTmdbTitle.includes(normProviderTitle)) score += 15;
    }
    const normalizeType = (typeStr) => {
        if (!typeStr) return undefined;
        const lowerType = typeStr.toLowerCase();
        if (lowerType.includes('movie')) return 'movie';
        if (lowerType.includes('tv') || lowerType.includes('show') || lowerType.includes('series')) return 'show';
        return undefined;
    };
    const providerType = normalizeType(providerItem.type);
    const tmdbType = tmdbInfo.type;
    if (providerType && tmdbType && providerType === tmdbType) score += 10;
    const providerYear = String(providerItem.year || providerItem.releaseDate).substring(0, 4);
    const tmdbYear = String(tmdbInfo.releaseDate).substring(0, 4);
    if (providerYear && tmdbYear && providerYear === tmdbYear) score += 10;
    if (tmdbType === 'show' && providerItem.seasons && tmdbInfo.totalSeasons && providerItem.seasons === tmdbInfo.totalSeasons) score += 5;
    // Minimal logging for score calculation to reduce noise during race
    // if (request && request.log) request.log.debug(`[Score] "${providerItem.title}" vs "${tmdbInfo.title}": ${score}`);
    return score;
}

// Modified to return data/null or throw; incorporates individual step timeouts
async function fetchSourcesFromSingleProvider(providerKey, providerInstance, tmdbMediaInfo, seasonNumber, episodeNumber, request) {
    const providerName = providerKey.toUpperCase();
    // Use request.log.debug for less critical logs during race to reduce verbosity
    request.log.debug(`[${providerName}] Racing: Starting attempt...`);
    try {
        const searchTitle = unidecode(tmdbMediaInfo.title);
        const searchResults = await timeoutPromise(
            providerInstance.search(searchTitle),
            SEARCH_TIMEOUT, providerName, 'Search', request
        );

        if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
            request.log.debug(`[${providerName}] Racing: No search results for "${searchTitle}".`);
            return null;
        }
        
        let bestMatch = { item: null, score: -1 };
        for (const item of searchResults.results) {
            if (!item.title) continue;
            const currentScore = calculateScore(item, tmdbMediaInfo, request);
            if (currentScore > bestMatch.score) bestMatch = { item, score: currentScore };
        }

        const MINIMUM_SCORE_THRESHOLD = 20;
        if (!bestMatch.item || bestMatch.score < MINIMUM_SCORE_THRESHOLD) {
            request.log.debug(`[${providerName}] Racing: No good match for "${tmdbMediaInfo.title}". Best score: ${bestMatch.score}`);
            return null;
        }

        const providerMediaId = bestMatch.item.id;
        request.log.debug(`[${providerName}] Racing: Match found "${bestMatch.item.title}" (ID: ${providerMediaId}). Fetching info...`);
        const providerMediaInfo = await timeoutPromise(
            providerInstance.fetchMediaInfo(providerMediaId),
            MEDIA_INFO_TIMEOUT, providerName, 'Fetch Media Info', request
        );

        if (!providerMediaInfo || !providerMediaInfo.id) {
            request.log.debug(`[${providerName}] Racing: Could not fetch media info for ID ${providerMediaId}.`);
            return null;
        }
        
        let episodeIdToFetch;
        const mediaIdForSources = providerMediaInfo.id; 

        if (tmdbMediaInfo.type === 'movie') {
            episodeIdToFetch = providerMediaInfo.episodeId || (providerMediaInfo.episodes && providerMediaInfo.episodes.length > 0 ? providerMediaInfo.episodes[0].id : mediaIdForSources);
        } else if (tmdbMediaInfo.type === 'show' && seasonNumber !== undefined && episodeNumber !== undefined) {
            if (!providerMediaInfo.episodes || providerMediaInfo.episodes.length === 0) {
                request.log.debug(`[${providerName}] Racing: No episodes listed for TV show "${providerMediaInfo.title}".`); return null;
            }
            const targetEpisode = providerMediaInfo.episodes.find(ep => ep.season === seasonNumber && ep.number === episodeNumber);
            if (!targetEpisode) {
                request.log.debug(`[${providerName}] Racing: Episode S${seasonNumber}E${episodeNumber} not found for "${providerMediaInfo.title}".`); return null;
            }
            episodeIdToFetch = targetEpisode.id;
        } else {
            request.log.warn(`[${providerName}] Racing: Invalid TMDB type or missing S/E numbers.`); return null; 
        }

        if (!episodeIdToFetch) {
            request.log.debug(`[${providerName}] Racing: Could not determine episode ID for "${tmdbMediaInfo.title}".`); return null;
        }
        
        request.log.debug(`[${providerName}] Racing: Fetching sources for MediaID: ${mediaIdForSources}, EpisodeID: ${episodeIdToFetch}`);
        const sourcesData = await timeoutPromise(
            providerInstance.fetchEpisodeSources(episodeIdToFetch, mediaIdForSources),
            SOURCES_TIMEOUT, providerName, 'Fetch Episode Sources', request
        );

        if (sourcesData && sourcesData.sources && sourcesData.sources.length > 0) {
            request.log.info(`[${providerName}] Racing: SUCCESS - Found ${sourcesData.sources.length} sources.`);
            return { providerKey, sources: sourcesData };
        } else {
            request.log.debug(`[${providerName}] Racing: No sources returned by provider.`);
            return null;
        }
    } catch (error) {
        // Logged by timeoutPromise or if error is not a timeout
        if (!error.message.includes('timed out')) { // Avoid double logging timeouts
            request.log.warn(`[${providerName}] Racing: Error - ${error.message}`);
        }
        throw error; // Propagate error to be caught by raceToFirstSuccess
    }
}

// Custom race function: resolves with the first promise that returns a "truthy" value (i.e., actual sources)
function raceToFirstSuccess(promiseEntries, request) { // promiseEntries: Array of { key: string, promise: Promise }
  return new Promise((resolve, reject) => {
    let resolved = false;
    const errors = [];
    let settledCount = 0;

    if (!promiseEntries || promiseEntries.length === 0) {
      reject(new Error("No promises to race."));
      return;
    }

    promiseEntries.forEach(({ key, promise }) => {
      promise
        .then(value => { // value from fetchSourcesFromSingleProvider is { providerKey, sources } or null
          if (!resolved && value && value.sources && value.providerKey === key) {
            resolved = true;
            request.log.info(`[RaceWin] Provider ${key.toUpperCase()} won the race.`);
            resolve(value);
          } else if (value === null) {
            request.log.debug(`[Race] Provider ${key.toUpperCase()} completed but found no sources.`);
          }
        })
        .catch(error => {
          errors.push({ key, message: error.message }); // Store key with error
          request.log.debug(`[RaceFail] Provider ${key.toUpperCase()} failed or timed out in race: ${error.message}`);
        })
        .finally(() => {
          settledCount++;
          if (settledCount === promiseEntries.length && !resolved) {
            const errorSummary = errors.map(e => `(${e.key}: ${e.message})`).join(', ');
            reject(new Error(`All providers failed or found no sources in race. Failures: [${errorSummary || 'No specific errors, but no data found.'}]`));
          }
        });
    });
  });
}

app.get('/vidsrc', async (request, reply) => {
    const tmdbId = request.query.id;
    const seasonNumber = request.query.s ? parseInt(request.query.s, 10) : undefined;
    const episodeNumber = request.query.e ? parseInt(request.query.e, 10) : undefined;
    const preferredProviderKey = request.query.provider?.toLowerCase();

    if (!tmdbId) return reply.status(400).send({ message: "TMDB ID ('id') is required." });

    let tmdbMediaInfo;
    const tmdb = new META.TMDB(tmdbApi);
    const type = (seasonNumber !== undefined && episodeNumber !== undefined) ? 'show' : 'movie';

    try {
        request.log.info(`Workspaceing TMDB for ID: ${tmdbId}, type: ${type}`);
        const rawTmdbInfo = await timeoutPromise(tmdb.fetchMediaInfo(tmdbId, type), 5000, "TMDB", "Fetch Info", request);
        if (!rawTmdbInfo || !rawTmdbInfo.title) {
            return reply.status(404).send({ message: `TMDB ID ${tmdbId} not found or info incomplete.` });
        }
        tmdbMediaInfo = rawTmdbInfo;
        tmdbMediaInfo.type = type;
        request.log.info(`TMDB Info for "${tmdbMediaInfo.title}" (Type: ${type})`);
    } catch (error) {
        request.log.error(`TMDB fetch error for ID ${tmdbId}: ${error.message}`);
        return reply.status(500).send({ message: 'Failed to fetch media information from TMDB.' });
    }

    let providersToAttemptKeys = [...DEFAULT_PROVIDER_ORDER];
    if (preferredProviderKey) {
        if (!PROVIDER_CLASSES[preferredProviderKey]) {
            return reply.status(400).send({ message: `Provider '${preferredProviderKey}' is not supported. Supported: ${Object.keys(PROVIDER_CLASSES).join(', ')}` });
        }
        providersToAttemptKeys = [preferredProviderKey, ...providersToAttemptKeys.filter(pKey => pKey !== preferredProviderKey)];
    }
    
    request.log.info(`Racing providers: [${providersToAttemptKeys.join(', ')}] for "${tmdbMediaInfo.title}"`);

    const providerPromiseEntries = providersToAttemptKeys.map(providerKey => {
        const ProviderClass = PROVIDER_CLASSES[providerKey];
        // This check should be redundant if DEFAULT_PROVIDER_ORDER is pre-filtered
        if (!ProviderClass) return null; 
        const providerInstance = new ProviderClass();
        return {
            key: providerKey,
            promise: fetchSourcesFromSingleProvider(
                providerKey, providerInstance, tmdbMediaInfo,
                seasonNumber, episodeNumber, request
            )
        };
    }).filter(Boolean); // Remove null entries if any provider class was missing

    if (providerPromiseEntries.length === 0) {
        request.log.warn("No valid providers configured or available to attempt.");
        return reply.status(404).send({ message: 'No providers available to search for sources.' });
    }

    try {
        const winningResult = await raceToFirstSuccess(providerPromiseEntries, request);
        request.log.info(`Sources found via ${winningResult.providerKey.toUpperCase()} (raced) for "${tmdbMediaInfo.title}".`);
        return reply.status(200).send({
            message: `Sources retrieved from ${winningResult.providerKey.toUpperCase()} (raced)`,
            provider: winningResult.providerKey,
            data: winningResult.sources // Removed tmdbInfo from here to keep payload smaller, client already has ID
        });
    } catch (error) { // From raceToFirstSuccess (all promises failed or returned null)
        request.log.warn(`All providers in race failed for "${tmdbMediaInfo.title}". Error: ${error.message}`);
        return reply.status(404).send({ message: error.message || 'No sources found from any provider after racing attempts.' });
    }
});

const start = async () => {
    try {
        const port = parseInt(process.env.PORT || "3001", 10);
        await app.listen({ port: port, host: '0.0.0.0' });
        app.log.info(`AIO Streamer (Fast Concurrent Mode) on port ${port}. Default provider order: [${DEFAULT_PROVIDER_ORDER.join(', ')}]`);
        app.log.info(`Provider operation timeouts: Search=${SEARCH_TIMEOUT}ms, MediaInfo=${MEDIA_INFO_TIMEOUT}ms, Sources=${SOURCES_TIMEOUT}ms`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
