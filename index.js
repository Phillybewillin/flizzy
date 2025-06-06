import 'dotenv/config';
import fastify from 'fastify';
import { META, MOVIES } from '@consumet/extensions';
import unidecode from 'unidecode';
import cors from '@fastify/cors';

const app = fastify({ logger: true });
const tmdbApi = process.env.TMDB_KEY; // Ensure this is correctly set in Vercel

const PROVIDER_CLASSES = {
    flixhq: MOVIES.FlixHQ,
    himovies: MOVIES.Himovies,
    goku: MOVIES.Goku,
    moviehdwatch: MOVIES.MovieHdWatch,
   // viewasian: MOVIES.ViewAsian,
    sflix: MOVIES.SFlix,
    multimovies: MOVIES.MultiMovies,
    netflixmirror: MOVIES.NetflixMirror,
    //dramacool: MOVIES.DramaCool,
    fmovies: MOVIES.Fmovies,
    
    //kissasian: MOVIES.KissAsian,
  
};

const DEFAULT_PROVIDER_ORDER = [
    'flixhq','himovies', 'goku', 'moviehdwatch',
     'multimovies', 'netflixmirror', 'fmovies' ,'sflix',
].filter(key => PROVIDER_CLASSES[key]);

// --- Timeouts (in milliseconds) ---
const TMDB_FETCH_TIMEOUT = 20000;   // Increased to 8 seconds for TMDB metadata call
const SEARCH_TIMEOUT = 20000;
const MEDIA_INFO_TIMEOUT = 20000;
const SOURCES_TIMEOUT = 20000;

app.register(cors, {
    origin: ['https://moviepluto.fun', 'http://localhost:5173', ...(process.env.NODE_ENV === 'development' ? ['http://127.0.0.1:5173'] : [])],
    methods: ['GET', 'POST']
});

app.get('/', async (request, reply) => {
    return {
        intro: "Welcome to the unofficial multi-provider resolver (Fast Concurrent Mode).",
        documentation: "Check GitHub for more info.",
        author: "Original by Inside4ndroid, modified for speed and failover."
    };
});

async function timeoutPromise(promise, ms, serviceName, operationName, request) {
    let timer;
    const timeoutError = new Error(`[${serviceName}] ${operationName} timed out after ${ms}ms`);
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            if (request && request.log) request.log.warn(timeoutError.message);
            reject(timeoutError);
        }, ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function calculateScore(providerItem, tmdbInfo, request) {
    // ... (calculateScore function remains the same as previous version)
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
    return score;
}

async function fetchSourcesFromSingleProvider(providerKey, providerInstance, tmdbMediaInfo, seasonNumber, episodeNumber, request) {
    // ... (fetchSourcesFromSingleProvider function remains the same as previous version)
    const providerName = providerKey.toUpperCase();
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
        if (!error.message.includes('timed out')) {
            request.log.warn(`[${providerName}] Racing: Error - ${error.message}`);
        }
        throw error;
    }
}

function raceToFirstSuccess(promiseEntries, request) {
    // ... (raceToFirstSuccess function remains the same as previous version)
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
            .then(value => { 
            if (!resolved && value && value.sources && value.providerKey === key) {
                resolved = true;
                request.log.info(`[RaceWin] Provider ${key.toUpperCase()} won the race.`);
                resolve(value);
            } else if (value === null) {
                request.log.debug(`[Race] Provider ${key.toUpperCase()} completed but found no sources.`);
            }
            })
            .catch(error => {
            errors.push({ key, message: error.message }); 
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
    if (!tmdbApi) {
        request.log.error("TMDB_KEY environment variable is not set!");
        return reply.status(500).send({ message: "Server configuration error: TMDB API key not set." });
    }

    let tmdbMediaInfo;
    const tmdb = new META.TMDB(tmdbApi);
    const type = (seasonNumber !== undefined && episodeNumber !== undefined) ? 'show' : 'movie';

    try {
        request.log.info(`Attempting to fetch TMDB for ID: ${tmdbId}, type: ${type}`);
        const rawTmdbInfo = await timeoutPromise(
            tmdb.fetchMediaInfo(tmdbId, type),
            TMDB_FETCH_TIMEOUT, // Using the defined constant
            "TMDB", "Fetch Info", request
        );

        if (!rawTmdbInfo || !rawTmdbInfo.title) {
            request.log.warn(`TMDB fetch for ID ${tmdbId} (type: ${type}) returned no title or incomplete data. Raw: ${JSON.stringify(rawTmdbInfo)}`);
            return reply.status(404).send({ message: `Media with TMDB ID ${tmdbId} (type: ${type}) not found on TMDB or TMDB returned incomplete data.` });
        }
        tmdbMediaInfo = rawTmdbInfo;
        tmdbMediaInfo.type = type;
        request.log.info(`TMDB Info for "${tmdbMediaInfo.title}" (Type: ${type}) successfully fetched.`);
    } catch (error) {
        // Log the actual error from TMDB attempt before sending generic client message
        request.log.error(`CRITICAL: TMDB fetch failed for ID ${tmdbId}. Error: ${error.message}`, error.stack);
        // Check if error message indicates an auth issue from TMDB
        if (error.message && (error.message.toLowerCase().includes("invalid api key") || error.message.includes("authentication failed"))) {
             return reply.status(500).send({ message: 'Failed to fetch media information from TMDB due to API key or authentication issue. Please check server configuration.' });
        }
        return reply.status(500).send({ message: 'Failed to fetch media information from TMDB. Check server logs for details.' });
    }

    // ----- If TMDB fetch was successful, proceed to race providers -----
    request.log.info(`TMDB fetch successful for "${tmdbMediaInfo.title}". Proceeding to race streaming providers.`);
    
    let providersToAttemptKeys = [...DEFAULT_PROVIDER_ORDER];
    if (preferredProviderKey) {
        // ... (provider ordering logic remains the same) ...
        if (!PROVIDER_CLASSES[preferredProviderKey]) {
            return reply.status(400).send({ message: `Provider '${preferredProviderKey}' is not supported. Supported: ${Object.keys(PROVIDER_CLASSES).join(', ')}` });
        }
        providersToAttemptKeys = [preferredProviderKey, ...providersToAttemptKeys.filter(pKey => pKey !== preferredProviderKey)];
    }
    
    request.log.info(`Racing providers: [${providersToAttemptKeys.join(', ')}] for "${tmdbMediaInfo.title}"`);

    const providerPromiseEntries = providersToAttemptKeys.map(providerKey => {
        // ... (mapping to promise entries remains the same) ...
        const ProviderClass = PROVIDER_CLASSES[providerKey];
        if (!ProviderClass) return null; 
        const providerInstance = new ProviderClass();
        return {
            key: providerKey,
            promise: fetchSourcesFromSingleProvider(
                providerKey, providerInstance, tmdbMediaInfo,
                seasonNumber, episodeNumber, request
            )
        };
    }).filter(Boolean);

    if (providerPromiseEntries.length === 0) {
        // ... (handling for no providers remains the same) ...
        request.log.warn("No valid providers configured or available to attempt.");
        return reply.status(404).send({ message: 'No providers available to search for sources.' });
    }

    try {
        // ... (raceToFirstSuccess call and response remains the same) ...
        const winningResult = await raceToFirstSuccess(providerPromiseEntries, request);
        request.log.info(`Sources found via ${winningResult.providerKey.toUpperCase()} (raced) for "${tmdbMediaInfo.title}".`);
        return reply.status(200).send({
            message: `Sources retrieved from ${winningResult.providerKey.toUpperCase()} (raced)`,
            provider: winningResult.providerKey,
            data: winningResult.sources 
        });
    } catch (error) { 
        request.log.warn(`All providers in race failed for "${tmdbMediaInfo.title}". Error from race: ${error.message}`);
        return reply.status(404).send({ message: error.message || 'No sources found from any provider after racing attempts.' });
    }
});

const start = async () => {
    // ... (start function remains the same) ...
    try {
        const port = parseInt(process.env.PORT || "3001", 10);
        await app.listen({ port: port, host: '0.0.0.0' });
        app.log.info(`AIO Streamer (Fast Concurrent Mode) on port ${port}. Default provider order: [${DEFAULT_PROVIDER_ORDER.join(', ')}]`);
        app.log.info(`TMDB fetch timeout: ${TMDB_FETCH_TIMEOUT}ms`);
        app.log.info(`Provider operation timeouts: Search=${SEARCH_TIMEOUT}ms, MediaInfo=${MEDIA_INFO_TIMEOUT}ms, Sources=${SOURCES_TIMEOUT}ms`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
