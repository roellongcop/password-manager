// Wordlist for passphrase generation. Short, common, unambiguous English words.
// Duplicates are removed at load time, and generator.js computes entropy from the
// deduplicated length, so the list can be edited without recalculating anything.

const RAW = `
able about above acid acre actor adapt add adept admit adobe adopt adult agent agile
agree ahead aim air aisle alarm album alert alias alike alive alley allow alloy almond
alone along alpha also alter amber amble amend amino ample amuse angel anger angle ankle
annex answer ant anvil apex apple apply april apron arbor arcade arch arctic area arena
argue arise arm armor army aroma array arrow art ash aside ask aspen asset atlas atom
attic auburn audio audit august aunt auto autumn avenue avoid awake award aware away axis
axle bacon badge bagel baker balance balcony bald ball balm bamboo banana band banjo bank
banner barge bark barley barn barrel base basil basin basket bass batch bath baton bay
beach beacon bead beam bean bear beat beaver bed beech beef beetle began begin behind
being bell belly below belt bench bend benefit bengal berry berth beside best beta better
beyond bicycle bid big bike bill binary bind birch bird birth bishop bison bit bite bitter
black blade blame blank blast blaze blend bless blind blink bliss block blood bloom blue
blush board boat body boil bold bolt bond bone bonus book boost boot border born borrow
boss both bottle bottom bounce bound bow bowl box boxer brain brake branch brand brass
brave bread break breeze brick bridge brief bright bring brisk broad broken bronze brook
broom brother brown brush bubble bucket buddy budget buffalo bug build bulb bulk bull
bumper bunch bundle bunker burden burn burst bus bush busy butter button buyer buzz cabin
cable cactus cage cake calf call calm camel camera camp canal candy cane canoe canvas
canyon cap cape car carbon card cargo carpet carrot carry cart carve case cash casino
cask cast castle casual cat catch cause cave cedar celery cell cement census cent center
century chain chair chalk champ chance change chapel charge charm chart chase cheap check
cheek cheer cheese chef cherry chess chest chief child chill chime chin chip choice choir
choose chop chorus chosen chrome chunk churn cider cigar cinema circle circus citrus city
civic civil claim clam clamp clan clap clarify clash class claw clay clean clear clerk
clever click cliff climb clinic clip cloak clock clone close cloth cloud clover club
clump clutch coach coal coast coat cobra cocoa code coffee coil coin cold collar colony
color colt column comb combat come comedy comet comfort comic compass concert cone confirm
connect cook cool copper copy coral cord core cork corn corner correct cost cotton couch
cough could count county couple course cousin cover cow coyote cozy crab crack cradle
craft crane crash crate crawl crazy cream create credit creek crest crew cricket crime
crisp critic crop cross crowd crown crude cruise crumb crush crust cry crystal cube cuff
culture cup curb cure curl curry curse curve cushion custom cut cycle cypress dagger daily
dairy daisy dance danger dare dark dash data date dawn day dazzle deal dean dear debate
debris decade decide deck decor deep deer defend define degree delay delta demand denim
dense dental deny depart depend depth derby desert design desk detail detect device devote
dew diagram dial diamond diary dice diesel diet dig digital dime dinner direct dirt
disco dish disk ditch dive divide dizzy dock doctor dodge dog dollar dolphin domain dome
donate donkey donor door dose dot double dough dove down dozen draft drag dragon drain
drama draw dream dress drift drill drink drive drop drum dry duck duct dude due duet
dune dusk dust duty dwarf dwell dye eager eagle ear early earn earth ease east easy eat
echo eclipse edge edit eel effort egg eight either elbow elder elect elegant element elf
elite elk elm else embark ember emblem embrace emerald emit empty enable enact end energy
engage engine enjoy enlist enough enrich ensure enter entire entry envoy equal equip erase
error escape essay estate ethics evening event ever every evolve exact exam example excess
exchange excite exile exist exit expand expect expert expire explain export expose extend
extra eye fabric face fact fade fair fairy faith falcon fall fame family fan fancy far
farm fast fat fate father fault favor fawn feast feather feature fee feed feel fellow
female fence fern ferry festival fetch fever few fiber fiction field fierce fifth fig
figure file fill film filter final finch find fine finger finish fire firm first fiscal
fish fist fit five fix flag flame flash flat flavor flax fleet flesh flex flight flip
float flock flood floor flour flow flower fluid flute fly foam focus fog foil fold folk
follow food fool foot force forest forge fork form fort forum fossil foster found four
fox frame free freeze fresh friend fringe frog front frost frown frozen fruit fuel full
fun fund fungus funny fur future gadget gain galaxy gallery game gamma gap garage garden
garlic gas gate gather gauge gaze gear gecko gem gene gentle genuine ghost giant gift
ginger giraffe girl give glad glance glass glide globe gloom glory glove glow glue goal
goat gold golf good goose gorge gospel govern gown grab grace grade grain grand grant
grape graph grasp grass grave gravity gray great green greet grid grief grill grin grip
grit grocery groom groove ground group grove grow guard guess guest guide guitar gulf gull
gum gust guy gym habit hair half hall halt hammer hand handle hang harbor hard hare harm
harp harsh harvest hat hatch have hawk hay hazel head heal health heap hear heart heat
heavy hedge heel height helium hello helmet help hen herb herd here hero hidden hide high
hike hill hint hip hire history hobby hockey hold hole holiday hollow holy home honest
honey hood hoof hook hope horn horse hose host hotel hour house hover howl hub huge human
humble humor hundred hunger hunt hurdle hurry hurt husband hut hybrid ice icon idea ideal
idle image impact import impose improve impulse inch include income index indoor infant
inform inhale initial inject injury ink inner input inquiry insect inside insist inspire
install intact intend invest invite iron island issue item ivory ivy jacket jade jaguar
jail jam january jar jaw jazz jeans jelly jet jewel job jockey join joke journey joy judge
juice july jump june jungle junior jury just kale kayak keen keep kernel kettle key kick
kid kidney kind king kiosk kiss kit kite kitten knee knife knight knit knob knock knot
know koala lab label labor lace lack ladder lady lagoon lake lamb lamp lance land lane
language lantern lap large laser last late later laugh launch laundry lava law lawn layer
lazy lead leaf league lean leap learn lease leash least leather leave lecture ledge left
leg legacy legal legend lemon lend length lens leopard less lesson letter level lever
liberty library license life lift light like lilac lily limb lime limit line linen link
lion lip liquid list listen little live lizard load loan lobby local lock locust lodge
loft logic lonely long loop loose lord lorry lose lot loud love lower loyal luck luggage
lumber lunar lunch lung luxury lyric machine mad magic magnet maid mail main major make
mammal man manage mango mansion manual maple marble march margin marine mark market
marry marsh mask mason mass master match math matrix matter mature maximum maybe mayor
maze meadow meal mean measure meat medal media medium meet melody melon melt member memory
mention menu mercy merge merit merry mesh message metal meter method middle midnight might
mild mile milk mill mimic mind mine mineral minor mint minute miracle mirror miss mist
mix mobile model modern modest modify moist moment monday money monkey month moon moral
more morning mosaic most motel motion motor mount mouse mouth move movie much muffin mule
multiply muscle museum mushroom music must mutual myself mystery myth nail name napkin
narrow nation native nature navy near neat neck need needle neon nephew nerve nest net
network neutral never new news next nice niece night nine noble node noise noodle noon
normal north nose note nothing notice novel now nudge number nurse nut oak oasis oat
obey object oblige observe obtain ocean octopus odd offer office often oil okay old olive
omega omit once onion online only onto open opera opinion oppose option orange orbit
orchard order organ origin ornate orphan other otter ounce outdoor outer output outside
oval oven over owl own oxygen oyster ozone pace pack pact paddle page paint pair palace
pale palm panda panel panic paper parade parcel parent park parrot part party pass past
pasta patch path patient patio patrol pattern pause pave paw pay peace peach peak peanut
pear pearl pebble pecan pedal peer pelican pen pencil penny people pepper perch perfect
period permit person pet phase phone photo phrase piano pick picnic picture pie piece
pier pig pigeon pile pilgrim pill pillow pilot pin pine pink pint pioneer pipe pirate
pistol pit pitch pizza place plain plan plant plaster plate play plaza pledge plenty plot
plug plum plunge plus pocket poem poet point polar pole police policy polish pond pony
pool poor pop porch pork port portion post pot potato pottery pouch pound pour powder
power praise prawn pray precise prefer prepare present press pretty prevent price pride
prime print prison privacy prize problem produce profit program project promise proof
proper protect proud prove provide public pudding pull pulse pump punch pupil puppy pure
purple purpose purse push put puzzle pyramid quail quake quality quantum quarter queen
query quest question queue quick quiet quilt quit quiz quote rabbit raccoon race rack
radar radio radish raft rag rail rain raise rally ramp ranch random range rank rapid rare
rate rather rattle raven raw ray razor reach read ready real reason rebel recall receive
recipe record recover red reduce reef refer reflect reform refuse region regret regular
reject relax relay release relief rely remain remedy remind remove render renew rent
repair repeat replace reply report request rescue resist resort result retire retreat
return reveal review reward rhythm ribbon rice rich ride ridge rifle right rigid ring
rinse riot ripe rise risk ritual river road roast robin robot rock rocket rod rodeo role
roll roof room root rope rose rotate rough round route royal rubber ruby rug rule rumor
run runway rural rush rust sad saddle safe sage sail saint salad salmon salon salt same
sample sand satin satisfy sauce sausage save say scale scan scarf scatter scene scent
school science scissor scope score scout scrap screen script scrub sculpt sea seal search
season seat second secret section secure seed seek seem seize select self sell seminar
senate send senior sense sentence series serve session settle setup seven shade shadow
shaft shake shall shallow shame shape share shark sharp shed sheep sheet shelf shell
shelter shield shift shine ship shirt shock shoe shoot shop shore short shot should
shoulder shout show shower shrimp shrink shrug shuffle shut shy sibling sick side siege
sigh sight sign silent silk silly silver similar simple since sing sink sir sister sit
six size skate sketch ski skill skin skirt skull sky slab slam sleep sleeve slender slice
slide slight slim slogan slope slot slow small smart smell smile smoke smooth snack snake
snap sneak snow soap soccer social sock soda sofa soft soil solar soldier solid solve
some song soon sort soul sound soup source south space spare spark speak special speed
spell spend sphere spice spider spike spin spirit split spoil sponge spoon sport spot
spray spread spring sprout spy square squash squeeze squid stable stack staff stage
stair stamp stand star start state station statue stay steady steak steal steam steel
steep stem step stereo stick still sting stir stock stomach stone stool stop store storm
story stove strange straw stream street stress strike string strip strong struggle
student studio study stuff style subject submit subway such sudden suffer sugar suggest
suit summer summit sun sunny super supply support suppose sure surface surge surprise
survey suspect sustain swallow swamp swan swap swarm sweat sweet swift swim swing switch
sword symbol symptom syrup system table tackle tag tail tailor take tale talent talk tall
tank tape target task taste tattoo tax taxi tea teach team tear tech teeth tell temple
tempo tenant tennis tent term test text thank that theme then theory there these thick
thin thing think third thirty this thorn those thought thread three thrive throat throw
thumb thunder ticket tide tidy tie tiger tight tile timber time tiny tip tire title toast
today toe together toilet token tomato tomorrow ton tone tongue tonight tool tooth top
topic torch total touch tough tour toward towel tower town toy trace track trade traffic
tragic trail train trait tram trap trash travel tray treat tree trend trial tribe trick
trigger trim trip trophy tropic trouble truck true trumpet trunk trust truth try tube
tuition tulip tumble tuna tune tunnel turbo turkey turn turtle tutor twelve twenty twice
twin twist two type typical ugly umbrella uncle under undo unfair unfold unhappy unicorn
uniform union unique unit universe unlock until unusual upgrade uphold upon upper upset
urban urge usage use useful usual utility vacant vacuum vague valid valley value valve
van vanish vapor variety vast vault vector vehicle velvet vendor venture venue verb
verify version very vessel veteran viable vibrant vicious victory video view village
vintage violin virtue visa visible vision visit visual vital vivid vocal voice void
volcano volume vote voyage wage wagon waist wait wake walk wall walnut want war warm
warn wash wasp waste watch water wave wax way weak wealth wear weather weave web wedding
week weight weird welcome well west wet whale what wheat wheel when where which while
whip whisper white whole why wide widget width wife wild will win wind window wine wing
wink winner winter wire wisdom wise wish wit witness wolf woman wonder wood wool word
work world worry worth would wound wrap wrist write wrong yard yarn year yellow yes
yesterday yet yield yoga yogurt young youth zebra zero zest zinc zone zoo
`;

export const WORDS = Object.freeze([...new Set(RAW.trim().split(/\s+/))]);
