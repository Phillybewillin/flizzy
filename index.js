import 'dotenv/config';
import fastify from 'fastify';
import { META , MOVIES } from '@consumet/extensions';
import unidecode from 'unidecode';
import { fetchSources } from './src/flixhq/flixhq.js';
import cors from '@fastify/cors';

const app = fastify();

const tmdbApi = process.env.TMDB_KEY;
const port = process.env.PORT;

app.register(cors, { 
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST'],
  })

app.get('/', async (request, reply) => {
    return {
        intro: "Welcome to the unofficial multi provider resolver and eporner api currently the ONLY All-In-One solution aswell as additional Eporner resolver.",
        documentation: "Please see github repo : https://github.com/Inside4ndroid/AIO-StreamSource",
        author: "This api is developed and created by Inside4ndroid"
    };
});

app.get('/vidsrc', async (request, reply) => {
   
    const id = request.query.id;
    const seasonNumber = parseInt(request.query.s, 10);
    const episodeNumber = parseInt(request.query.e, 10);
    const provider = request.query.provider;

    if (!provider) {
        return reply.status(400).send({ message: "The 'provider' query is required" });
    }

    const fetchFlixhq = async (id, seasonNumber, episodeNumber) => {
        let tmdb = new META.TMDB(tmdbApi);
        let flixhq = new MOVIES.FlixHQ();
        let goku = new MOVIES.Goku();
        let type = seasonNumber && episodeNumber ? 'show' : 'movie';
        console.log(` 1 Fetching media info for ID: ${id} and type: ${type}`);
         
        try {
            //console.log(` 2 Fetching media info for ID: ${id} and type: ${type}`);
            const res = await tmdb.fetchMediaInfo(id, type);

            //console.log(res)
            const resAbdolute = unidecode(res.title)
            console.log('resAbdolute:', resAbdolute);
            const flixhqResults = await flixhq.search(unidecode(resAbdolute));
            //console.log('flixhqResults:', flixhqResults);
            const gokuResults = await goku.search(unidecode(resAbdolute));
            //console.log('gokuResults:', gokuResults);

            const flixhqItem = gokuResults.results.reduce((bestMatch, item) => {
              const score = calculateScore(item, res);
              if (!bestMatch || score > bestMatch.score) {
                console.log('Best match:', item.title, item.id, score);
                return { item, score };
              }
              //console.log('Not best match:', item.id, bestMatch);
              return bestMatch;
            }, { item: null, score: 0 });
            
            function calculateScore(item, res) {
              let score = 0;
              if (item.title === res.title) score += 20;
              if (item.type === res.type) score += 5;
              if (item.releaseDate === res.releaseDate.substring(0, 4)) score += 10;
              if (item.seasons === res.totalSeasons) score += 10;
              //console.log('score:',item.title, score);
              // Add more conditions as needed
              return score;
            }
            
            if (!flixhqItem.item) {
              console.log('No matching movie found on FlixHQ.', item.title, item.type, 'res.title:', res.title, 'res.type:', res.type);
              return reply.status(404).send({ message: 'Matching movie not found on FlixHQ.' });
            }
            
            const mid = flixhqItem.item.id;
            console.log('Mid:', mid)
            
            const flixMedia = await goku.fetchMediaInfo(mid)

           //console.log('flix media info ', flixMedia );
          
            let episodeId;

            if (mid.startsWith('watch-movie/')) {
                //const parts = mid.split('-');
                episodeId = flixMedia.episodes[0].id;
                console.log('wSelected MID:', mid ,'Selected Episode ID:', episodeId);
                } else if (mid.startsWith('series/') && seasonNumber && episodeNumber) {

                    const episodex = flixMedia.episodes.find(episode => episode.number === episodeNumber && episode.season === seasonNumber);

                    if (!episodex) {
                        console.log('Episode not found.' );
                        return reply.status(404).send({ message: 'Episode not found' });
                    }

                    episodeId = episodex.id;
              
              }
            console.log('Selected MID:', mid ,'Selected Episode ID:', episodeId);
           
      
            const res1 =  await goku.fetchEpisodeSources(episodeId.toString(), mid.toString()).catch((err) => {
                return reply.status(404).send({ message: err });
            });
    
            if (res1 && res) {
                return reply.status(200).send({ data: res1 });
            } else {
                return reply.status(404).send({ message: 'Sources not found.' });
            }
        } catch (error) {
            //console.error('TMDB class version:', tmdb.version);
            return reply.status(500).send({ message: 'Something went wrong. Contact developer for help.' , error });
        }
    };
    
    if (provider === 'flixhq') {
        await fetchFlixhq(id, seasonNumber, episodeNumber);
    }
    else {
        return reply.status(400).send({ message: 'Invalid provider specified' });
    }
});

const start = async () => {
    try {
        const port = process.env.PORT || 3000;  // Use Render's provided port or fallback to 3000
        await app.listen({ port: port, host: '0.0.0.0' }); // Bind to 0.0.0.0 to listen on all interfaces
        console.log(`AIO Streamer is listening on ${process.env.URL}`);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

start();
